import { Command } from 'commander';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { writeManifest } from '../manifest.js';
import type { PoliPageManifest } from '../manifest.js';

function toKebabCase(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

const TAILWIND_CSS_TEMPLATE = `@import 'tailwindcss';

@theme {
\t--font-sans: 'Inter', sans-serif;
}
`;

const GITIGNORE_TEMPLATE = `node_modules
output/
dist/
.DS_Store
`;

export interface InitOptions {
	cwd?: string;
}

export async function executeInit(name: string, options: InitOptions = {}): Promise<string> {
	const cwd = options.cwd ?? process.cwd();
	const initInPlace = name === '.';
	const projectName = initInPlace ? basename(cwd) : toKebabCase(name);
	const projectDir = initInPlace ? cwd : join(cwd, projectName);

	if (!initInPlace) {
		const exists = await stat(projectDir).catch(() => null);
		if (exists) {
			throw new Error(`Directory "${projectName}" already exists.`);
		}
		await mkdir(projectDir, { recursive: true });
	}

	const manifest: PoliPageManifest = {
		project: {
			name: projectName,
			version: '1.0',
		},
		fonts: [],
		templates: [],
	};

	await writeManifest(projectDir, manifest);
	await mkdir(join(projectDir, 'templates'), { recursive: true });
	await mkdir(join(projectDir, 'assets'), { recursive: true });
	await writeFile(join(projectDir, 'tailwind.css'), TAILWIND_CSS_TEMPLATE, 'utf-8');
	await writeFile(join(projectDir, '.gitignore'), GITIGNORE_TEMPLATE, 'utf-8');

	return projectDir;
}

export function registerInitCommand(program: Command) {
	program
		.command('init')
		.description('Scaffold a new Poli Page project')
		.argument('<name>', 'Project name (or "." for current directory)')
		.action(async (name: string) => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			const spinner = ora('Creating project...').start();
			try {
				const projectDir = await executeInit(name);
				spinner.succeed(chalk.green(`Project created at ${projectDir}`));
				console.log();
				console.log(`  ${chalk.bold('Next steps:')}`);
				console.log(`  ${chalk.cyan(`cd ${name === '.' ? '.' : toKebabCase(name)}`)}`);
				console.log(`  ${chalk.cyan('poli new invoice')}  — create your first template`);
				console.log();
			} catch (error) {
				spinner.fail(
					chalk.red(error instanceof Error ? error.message : 'Failed to create project')
				);
				process.exitCode = 1;
			}
		});
}
