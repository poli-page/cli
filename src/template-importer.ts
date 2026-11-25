import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readManifest, writeManifest } from './manifest.js';
import { MANIFEST_FILENAME } from './constants.js';
import {
	assertSafeRelativePath,
	isSafeDottedSegment,
	isSafeSegment,
	resolveInside,
} from './security/paths.js';

export interface TemplateSource {
	owner: string;
	repo: string;
}

export interface TemplateRef {
	collection: string;
	name: string;
}

export interface IndexCollection {
	title: string;
	description: string;
	templates: Array<{ name: string; description: string }>;
}

export interface TemplateIndex {
	$schema?: string;
	collections: Record<string, IndexCollection>;
}

export interface TemplateManifestFontEntry {
	family: string;
	src: string;
	weight: number;
	style?: string;
	[key: string]: unknown;
}

export interface TemplateManifest {
	template: {
		name: string;
		template: string;
		mock: string;
		format?: string;
		orientation?: string;
	};
	images?: string[];
	fonts?: TemplateManifestFontEntry[];
}

export type ConflictResolution = 'overwrite' | 'duplicate' | 'skip';

export interface ConflictInfo {
	type: 'font' | 'image';
	filename: string;
	destPath: string;
	sourceContent: Buffer;
	destContent: Buffer;
}

export type ConflictHandler = (info: ConflictInfo) => Promise<ConflictResolution>;
export type Fetcher = (url: string) => Promise<Response>;

export interface ImportTemplateOptions {
	source?: TemplateSource;
	templateRef: TemplateRef;
	destTemplateName?: string;
	projectDir: string;
	fetcher?: Fetcher;
	homeDir?: string;
	noCache?: boolean;
	onConflict?: ConflictHandler;
}

export interface ImportTemplateResult {
	destTemplateName: string;
	copiedImages: string[];
	copiedFonts: string[];
	appendedTailwind: boolean;
}

export const DEFAULT_SOURCE: TemplateSource = { owner: 'poli-page', repo: 'templates' };

const RAW_GITHUB = 'https://raw.githubusercontent.com';
const GITHUB_API = 'https://api.github.com';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SOURCE_RE = /^(?:github:)?([^/:]+)\/([^/:]+)$/;
const TEMPLATE_REF_RE = /^([^/]+)\/([^/]+)$/;

export function parseSource(spec: string): TemplateSource {
	const m = spec.match(SOURCE_RE);
	// Owner and repo are segments of the fetch URLs and of the cache path.
	if (!m || !isSafeDottedSegment(m[1]) || !isSafeDottedSegment(m[2])) {
		throw new Error(`Invalid source format. Expected github:<owner>/<repo>, got "${spec}".`);
	}
	return { owner: m[1], repo: m[2] };
}

export function parseTemplateRef(spec: string): TemplateRef {
	const m = spec.match(TEMPLATE_REF_RE);
	if (!m || spec.split('/').length !== 2) {
		throw new Error(
			`Invalid template reference. Expected <collection>/<template>, got "${spec}".`
		);
	}
	return { collection: m[1], name: m[2] };
}

export interface FetchOptions {
	fetcher?: Fetcher;
	homeDir?: string;
	noCache?: boolean;
}

/**
 * Fetch and parse the source repo's `index.json`. Used by `importTemplate`
 * for validation, and by the interactive prompt to populate collection
 * and template choices.
 */
export async function fetchTemplateIndex(
	source: TemplateSource = DEFAULT_SOURCE,
	options: FetchOptions = {}
): Promise<TemplateIndex> {
	return fetchJson(source, 'index.json', options, parseTemplateIndex);
}

// Collection keys and template names become path segments of the fetch URLs,
// the cache and the project: refuse the whole index on the first bad one.
function parseTemplateIndex(data: unknown): TemplateIndex {
	const index = data as TemplateIndex;
	for (const [key, coll] of Object.entries(index.collections ?? {})) {
		if (!isSafeSegment(key)) {
			throw new Error(
				`Unsafe collection name ${JSON.stringify(key)} in the source index.json.`
			);
		}
		for (const t of coll.templates ?? []) {
			if (!isSafeSegment(t.name)) {
				throw new Error(
					`Unsafe template name ${JSON.stringify(t.name)} in collection "${key}" of the source index.json.`
				);
			}
		}
	}
	return index;
}

function parseTemplateManifest(data: unknown): TemplateManifest {
	const manifest = data as TemplateManifest;
	assertSafeRelativePath(manifest.template?.template, 'template.template');
	assertSafeRelativePath(manifest.template?.mock, 'template.mock');
	for (const field of ['fonts', 'images'] as const) {
		if (manifest[field] !== undefined && !Array.isArray(manifest[field])) {
			throw new Error(
				`Unsafe ${field}[]: expected an array, got ${JSON.stringify(manifest[field])}.`
			);
		}
	}
	for (const font of manifest.fonts ?? []) assertSafeRelativePath(font?.src, 'fonts[].src');
	for (const img of manifest.images ?? []) assertSafeRelativePath(img, 'images[]');
	return manifest;
}

async function fetchJson<T>(
	source: TemplateSource,
	relativePath: string,
	options: FetchOptions,
	parse: (data: unknown) => T
): Promise<T> {
	let parsed: T | undefined;
	await fetchRaw(source, relativePath, options, (buf) => {
		parsed = parse(JSON.parse(buf.toString('utf-8')));
	});
	return parsed as T;
}

/**
 * `accept` runs on the content, cached or fetched, and throws to refuse it;
 * refused content is never written to the cache.
 */
async function fetchRaw(
	source: TemplateSource,
	relativePath: string,
	options: FetchOptions,
	accept?: (buf: Buffer) => void
): Promise<Buffer> {
	const fetcher = options.fetcher ?? ((url: string) => fetch(url));
	const cachePath = await resolveInside(
		join(options.homeDir ?? homedir(), '.polipage', 'cache'),
		join(source.owner, source.repo, 'main', relativePath)
	);

	if (!options.noCache) {
		let cached: Buffer | undefined;
		try {
			const s = await stat(cachePath);
			if (Date.now() - s.mtimeMs < CACHE_TTL_MS) {
				cached = await readFile(cachePath);
			}
		} catch {
			// cache miss
		}
		if (cached) {
			accept?.(cached);
			return cached;
		}
	}

	const url = `${RAW_GITHUB}/${encodePath(`${source.owner}/${source.repo}/main/${relativePath}`)}`;
	const response = await fetcher(url);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch ${relativePath} from ${source.owner}/${source.repo} (HTTP ${response.status}).`
		);
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	accept?.(buffer);

	try {
		await mkdir(dirname(cachePath), { recursive: true });
		await writeFile(cachePath, buffer);
	} catch {
		// cache write failure is non-fatal
	}

	return buffer;
}

function encodePath(p: string): string {
	return p.split('/').map(encodeURIComponent).join('/');
}

export async function importTemplate(
	options: ImportTemplateOptions
): Promise<ImportTemplateResult> {
	const source = options.source ?? DEFAULT_SOURCE;
	const ref = options.templateRef;
	const destName = options.destTemplateName ?? ref.name;
	const fetchOpts: FetchOptions = {
		fetcher: options.fetcher,
		homeDir: options.homeDir,
		noCache: options.noCache,
	};

	// 1. Fetch + validate index
	const index = await fetchJson(source, 'index.json', fetchOpts, parseTemplateIndex);
	const coll = Object.hasOwn(index.collections ?? {}, ref.collection)
		? index.collections[ref.collection]
		: undefined;
	if (!coll) {
		throw new Error(
			`Unknown collection "${ref.collection}" in source ${source.owner}/${source.repo}.`
		);
	}
	if (!coll.templates.some((t) => t.name === ref.name)) {
		throw new Error(
			`Template "${ref.name}" not found in collection "${ref.collection}". Available: ${coll.templates.map((t) => t.name).join(', ')}.`
		);
	}

	// 2. Check destination doesn't already exist in the project
	const destDir = await resolveInside(options.projectDir, join('templates', destName));
	// The import rewrites these two root files: refuse a symlink out of the
	// project before anything is written.
	const tailwindPath = await resolveInside(options.projectDir, 'tailwind.css');
	await resolveInside(options.projectDir, MANIFEST_FILENAME);
	if (existsSync(destDir)) {
		throw new Error(
			`Template "${destName}" already exists in this project. Pick a different --template-name or remove the existing folder.`
		);
	}

	// 3. Fetch the per-template manifest + body files + tailwind block
	const tplBase = `${ref.collection}/templates/${ref.name}`;
	const tplManifest = await fetchJson(
		source,
		`${tplBase}/manifest.json`,
		fetchOpts,
		parseTemplateManifest
	);
	// Resolve every asset destination before the first write, so a symlink
	// out of the project refuses the import with nothing written.
	const assetsDir = await resolveInside(options.projectDir, 'assets');
	const destFontPaths: string[] = [];
	for (const font of tplManifest.fonts ?? []) {
		destFontPaths.push(await resolveInside(assetsDir, font.src));
	}
	const destImgPaths: string[] = [];
	for (const imgFile of tplManifest.images ?? []) {
		destImgPaths.push(await resolveInside(assetsDir, join('images', imgFile)));
	}

	const htmlBuf = await fetchRaw(
		source,
		`${tplBase}/${tplManifest.template.template}`,
		fetchOpts
	);
	const mockBuf = await fetchRaw(source, `${tplBase}/${tplManifest.template.mock}`, fetchOpts);
	const taBuf = await fetchRaw(source, `${tplBase}/tailwind-additions.css`, fetchOpts);
	const tailwindAdditions = taBuf.toString('utf-8');

	// 4. Copy fonts (with conflict handling)
	const copiedFonts: string[] = [];
	const projectedFonts: TemplateManifestFontEntry[] = [];
	for (const [i, font] of (tplManifest.fonts ?? []).entries()) {
		const sourceFontPath = `${ref.collection}/assets/${font.src}`;
		const fontBuf = await fetchRaw(source, sourceFontPath, fetchOpts);
		const destFontPath = destFontPaths[i];
		const result = await writeAssetWithConflict(
			'font',
			basename(font.src),
			destFontPath,
			fontBuf,
			options.onConflict
		);
		const projected = { ...font };
		if (result.path !== destFontPath) {
			const newName = basename(result.path);
			projected.src = font.src.replace(basename(font.src), newName);
		}
		projectedFonts.push(projected);
		if (result.copied) copiedFonts.push(basename(result.path));
	}

	// 5. Copy images
	const copiedImages: string[] = [];
	for (const [i, imgFile] of (tplManifest.images ?? []).entries()) {
		const imgBuf = await fetchRaw(
			source,
			`${ref.collection}/assets/images/${imgFile}`,
			fetchOpts
		);
		const destImgPath = destImgPaths[i];
		const result = await writeAssetWithConflict(
			'image',
			imgFile,
			destImgPath,
			imgBuf,
			options.onConflict
		);
		if (result.copied) copiedImages.push(basename(result.path));
	}

	// 6. Copy template body files, renamed to match destName so the
	// project's `templates/<destName>/` is internally consistent
	// (folder name = template name = filename stem).
	const destHtmlName = `${destName}.html`;
	const destMockName = `${destName}.json`;
	await mkdir(destDir, { recursive: true });
	await writeFile(join(destDir, destHtmlName), htmlBuf);
	await writeFile(join(destDir, destMockName), mockBuf);

	// 7. Append tailwind block (idempotent — keyed by source <coll>/<tpl>)
	const markerKey = `${ref.collection}/${ref.name}`;
	const startMarker = `/* === poli-page-additions: ${markerKey} — start === */`;
	const endMarker = `/* === poli-page-additions: ${markerKey} — end === */`;
	const existingTailwind = await readFile(tailwindPath, 'utf-8');
	let appendedTailwind = false;
	if (!existingTailwind.includes(startMarker)) {
		const newBlock = `\n${startMarker}\n${tailwindAdditions.trimEnd()}\n${endMarker}\n`;
		await writeFile(tailwindPath, existingTailwind.trimEnd() + newBlock, 'utf-8');
		appendedTailwind = true;
	}

	// 8. Merge into poli-page.json
	const projectManifest = await readManifest(options.projectDir);
	projectManifest.templates = projectManifest.templates ?? [];
	projectManifest.fonts = projectManifest.fonts ?? [];

	projectManifest.templates.push({
		...tplManifest.template,
		name: destName,
		template: destHtmlName,
		mock: destMockName,
	});

	for (const font of projectedFonts) {
		const dup = projectManifest.fonts.find(
			(f) =>
				f.family === font.family &&
				f.weight === font.weight &&
				(f.style ?? 'normal') === (font.style ?? 'normal') &&
				f.src === font.src
		);
		if (!dup) {
			projectManifest.fonts.push(font);
		}
	}

	await writeManifest(options.projectDir, projectManifest);

	return { destTemplateName: destName, copiedImages, copiedFonts, appendedTailwind };
}

export interface StarterFile {
	/** Path relative to the starter folder, POSIX separators. */
	path: string;
	content: Buffer;
}

interface GitTreeResponse {
	tree?: Array<{ path: string; type: string }>;
	truncated?: boolean;
}

// Per-template metadata the templates repo keeps for `--with-template`
// imports. A project never carries them (the API seeds without them too).
const STARTER_IMPORT_ONLY_RE = /^templates\/[^/]+\/(?:manifest\.json|tailwind-additions\.css)$/;

/**
 * Fetch every file of a starter project — a top-level folder of the
 * source repo holding a `poli-page.json` (e.g. `getting-started/`).
 *
 * Raw GitHub URLs cannot list a folder, so the file list comes from the
 * repo's git tree (one GitHub API call, not cached); each file is then
 * fetched like any template file (raw URL, 24h cache). Nothing is
 * written to disk.
 */
export async function fetchStarter(
	starter: string,
	source: TemplateSource = DEFAULT_SOURCE,
	options: FetchOptions = {}
): Promise<StarterFile[]> {
	// A starter is one top-level folder of the source.
	if (!isSafeSegment(starter)) {
		throw new Error(
			`Invalid starter name "${starter}": a starter is a top-level folder of the source (e.g. getting-started).`
		);
	}
	const fetcher = options.fetcher ?? ((url: string) => fetch(url));
	const treeUrl = `${GITHUB_API}/repos/${encodePath(`${source.owner}/${source.repo}`)}/git/trees/main?recursive=1`;
	const response = await fetcher(treeUrl);
	if (!response.ok) {
		throw new Error(`Failed to list ${source.owner}/${source.repo} (HTTP ${response.status}).`);
	}
	const tree = (await response.json()) as GitTreeResponse;
	if (tree.truncated) {
		throw new Error(`The file list of ${source.owner}/${source.repo} is too large to read.`);
	}

	const prefix = `${starter}/`;
	const paths = (tree.tree ?? [])
		.filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix))
		.map((entry) => entry.path.slice(prefix.length))
		.filter((path) => !STARTER_IMPORT_ONLY_RE.test(path));

	if (!paths.includes(MANIFEST_FILENAME)) {
		throw new Error(`Unknown starter "${starter}" in source ${source.owner}/${source.repo}.`);
	}
	// Tree paths become fetch URLs, cache paths and project paths: refuse the
	// whole starter on the first bad one, before fetching any file.
	for (const path of paths) {
		if (!path.split('/').every(isSafeDottedSegment)) {
			throw new Error(
				`Unsafe path ${JSON.stringify(path)} in starter "${starter}" of source ${source.owner}/${source.repo}.`
			);
		}
	}

	const files: StarterFile[] = [];
	for (const path of paths) {
		files.push({ path, content: await fetchRaw(source, `${prefix}${path}`, options) });
	}
	return files;
}

async function writeAssetWithConflict(
	type: 'font' | 'image',
	filename: string,
	destPath: string,
	sourceContent: Buffer,
	onConflict?: ConflictHandler
): Promise<{ path: string; copied: boolean }> {
	let destContent: Buffer | undefined;
	try {
		destContent = await readFile(destPath);
	} catch {
		// destination doesn't exist
	}

	if (!destContent) {
		await mkdir(dirname(destPath), { recursive: true });
		await writeFile(destPath, sourceContent);
		return { path: destPath, copied: true };
	}

	if (sha256(destContent) === sha256(sourceContent)) {
		return { path: destPath, copied: false };
	}

	const handler = onConflict ?? defaultSkipHandler;
	const resolution = await handler({
		type,
		filename,
		destPath,
		sourceContent,
		destContent,
	});

	if (resolution === 'overwrite') {
		await writeFile(destPath, sourceContent);
		return { path: destPath, copied: true };
	}
	if (resolution === 'skip') {
		return { path: destPath, copied: false };
	}
	// duplicate
	const ext = extname(destPath);
	const stem = destPath.slice(0, destPath.length - ext.length);
	let counter = 2;
	let candidate = `${stem}-${counter}${ext}`;
	while (existsSync(candidate)) {
		counter++;
		candidate = `${stem}-${counter}${ext}`;
	}
	await writeFile(await resolveInside(dirname(destPath), basename(candidate)), sourceContent);
	return { path: candidate, copied: true };
}

const defaultSkipHandler: ConflictHandler = async (info) => {
	console.warn(
		`⚠ ${info.type} "${info.filename}" already exists at ${info.destPath} with different content — skipping. Re-run interactively to overwrite.`
	);
	return 'skip';
};

function sha256(buf: Buffer): string {
	return createHash('sha256').update(buf).digest('hex');
}
