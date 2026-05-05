import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readManifest, writeManifest } from './manifest.js';

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
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SOURCE_RE = /^(?:github:)?([^/:]+)\/([^/:]+)$/;
const TEMPLATE_REF_RE = /^([^/]+)\/([^/]+)$/;

export function parseSource(spec: string): TemplateSource {
	const m = spec.match(SOURCE_RE);
	if (!m) {
		throw new Error(
			`Invalid source format. Expected github:<owner>/<repo>, got "${spec}".`
		);
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

interface FetchOptions {
	fetcher?: Fetcher;
	homeDir?: string;
	noCache?: boolean;
}

async function fetchRaw(
	source: TemplateSource,
	relativePath: string,
	options: FetchOptions
): Promise<Buffer> {
	const fetcher = options.fetcher ?? ((url: string) => fetch(url));
	const cacheRoot = join(
		options.homeDir ?? homedir(),
		'.polipage',
		'cache',
		source.owner,
		source.repo,
		'main'
	);
	const cachePath = join(cacheRoot, relativePath);

	if (!options.noCache) {
		try {
			const s = await stat(cachePath);
			if (Date.now() - s.mtimeMs < CACHE_TTL_MS) {
				return readFile(cachePath);
			}
		} catch {
			// cache miss
		}
	}

	const url = `${RAW_GITHUB}/${source.owner}/${source.repo}/main/${relativePath}`;
	const response = await fetcher(url);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch ${relativePath} from ${source.owner}/${source.repo} (HTTP ${response.status}).`
		);
	}

	const buffer = Buffer.from(await response.arrayBuffer());

	try {
		await mkdir(dirname(cachePath), { recursive: true });
		await writeFile(cachePath, buffer);
	} catch {
		// cache write failure is non-fatal
	}

	return buffer;
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
	const indexBuf = await fetchRaw(source, 'index.json', fetchOpts);
	const index = JSON.parse(indexBuf.toString('utf-8')) as TemplateIndex;
	const coll = index.collections?.[ref.collection];
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
	const destDir = join(options.projectDir, 'templates', destName);
	if (existsSync(destDir)) {
		throw new Error(
			`Template "${destName}" already exists in this project. Pick a different --template-name or remove the existing folder.`
		);
	}

	// 3. Fetch the per-template manifest + body files + tailwind block
	const tplBase = `${ref.collection}/templates/${ref.name}`;
	const manifestBuf = await fetchRaw(source, `${tplBase}/manifest.json`, fetchOpts);
	const tplManifest = JSON.parse(manifestBuf.toString('utf-8')) as TemplateManifest;

	const htmlBuf = await fetchRaw(
		source,
		`${tplBase}/${tplManifest.template.template}`,
		fetchOpts
	);
	const mockBuf = await fetchRaw(
		source,
		`${tplBase}/${tplManifest.template.mock}`,
		fetchOpts
	);
	const taBuf = await fetchRaw(source, `${tplBase}/tailwind-additions.css`, fetchOpts);
	const tailwindAdditions = taBuf.toString('utf-8');

	// 4. Copy fonts (with conflict handling)
	const copiedFonts: string[] = [];
	const projectedFonts: TemplateManifestFontEntry[] = [];
	for (const font of tplManifest.fonts ?? []) {
		const sourceFontPath = `${ref.collection}/assets/${font.src}`;
		const fontBuf = await fetchRaw(source, sourceFontPath, fetchOpts);
		const destFontPath = join(options.projectDir, 'assets', font.src);
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
	for (const imgFile of tplManifest.images ?? []) {
		const imgBuf = await fetchRaw(
			source,
			`${ref.collection}/assets/images/${imgFile}`,
			fetchOpts
		);
		const destImgPath = join(options.projectDir, 'assets', 'images', imgFile);
		const result = await writeAssetWithConflict(
			'image',
			imgFile,
			destImgPath,
			imgBuf,
			options.onConflict
		);
		if (result.copied) copiedImages.push(basename(result.path));
	}

	// 6. Copy template body files
	await mkdir(destDir, { recursive: true });
	await writeFile(join(destDir, tplManifest.template.template), htmlBuf);
	await writeFile(join(destDir, tplManifest.template.mock), mockBuf);

	// 7. Append tailwind block (idempotent — keyed by source <coll>/<tpl>)
	const markerKey = `${ref.collection}/${ref.name}`;
	const startMarker = `/* === poli-page-additions: ${markerKey} — start === */`;
	const endMarker = `/* === poli-page-additions: ${markerKey} — end === */`;
	const tailwindPath = join(options.projectDir, 'tailwind.css');
	const existingTailwind = await readFile(tailwindPath, 'utf-8');
	let appendedTailwind = false;
	if (!existingTailwind.includes(startMarker)) {
		const newBlock = `\n${startMarker}\n${tailwindAdditions.trimEnd()}\n${endMarker}\n`;
		await writeFile(
			tailwindPath,
			existingTailwind.trimEnd() + newBlock,
			'utf-8'
		);
		appendedTailwind = true;
	}

	// 8. Merge into poli-page.json
	const projectManifest = await readManifest(options.projectDir);
	projectManifest.templates = projectManifest.templates ?? [];
	projectManifest.fonts = projectManifest.fonts ?? [];

	projectManifest.templates.push({
		...tplManifest.template,
		name: destName,
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
	await writeFile(candidate, sourceContent);
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
