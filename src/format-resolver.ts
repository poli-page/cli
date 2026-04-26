type Orientation = 'portrait' | 'landscape';

interface PageFormat {
	name: string;
	width: number;
	height: number;
	orientation: Orientation;
}

const FORMAT_MAP: Record<string, Record<string, PageFormat>> = {
	A3: {
		portrait: { name: 'A3', width: 297, height: 420, orientation: 'portrait' },
		landscape: { name: 'A3', width: 420, height: 297, orientation: 'landscape' },
	},
	A4: {
		portrait: { name: 'A4', width: 210, height: 297, orientation: 'portrait' },
		landscape: { name: 'A4', width: 297, height: 210, orientation: 'landscape' },
	},
	A5: {
		portrait: { name: 'A5', width: 148, height: 210, orientation: 'portrait' },
		landscape: { name: 'A5', width: 210, height: 148, orientation: 'landscape' },
	},
	A6: {
		portrait: { name: 'A6', width: 105, height: 148, orientation: 'portrait' },
		landscape: { name: 'A6', width: 148, height: 105, orientation: 'landscape' },
	},
	B4: {
		portrait: { name: 'B4', width: 250, height: 353, orientation: 'portrait' },
		landscape: { name: 'B4', width: 353, height: 250, orientation: 'landscape' },
	},
	B5: {
		portrait: { name: 'B5', width: 176, height: 250, orientation: 'portrait' },
		landscape: { name: 'B5', width: 250, height: 176, orientation: 'landscape' },
	},
	LETTER: {
		portrait: { name: 'Letter', width: 216, height: 279, orientation: 'portrait' },
		landscape: { name: 'Letter', width: 279, height: 216, orientation: 'landscape' },
	},
	LEGAL: {
		portrait: { name: 'Legal', width: 216, height: 356, orientation: 'portrait' },
		landscape: { name: 'Legal', width: 356, height: 216, orientation: 'landscape' },
	},
	TABLOID: {
		portrait: { name: 'Tabloid', width: 279, height: 432, orientation: 'portrait' },
		landscape: { name: 'Tabloid', width: 432, height: 279, orientation: 'landscape' },
	},
	STATEMENT: {
		portrait: { name: 'Statement', width: 140, height: 216, orientation: 'portrait' },
		landscape: { name: 'Statement', width: 216, height: 140, orientation: 'landscape' },
	},
	EXECUTIVE: {
		portrait: { name: 'Executive', width: 184, height: 267, orientation: 'portrait' },
		landscape: { name: 'Executive', width: 267, height: 184, orientation: 'landscape' },
	},
	FOLIO: {
		portrait: { name: 'Folio', width: 215, height: 330, orientation: 'portrait' },
		landscape: { name: 'Folio', width: 330, height: 215, orientation: 'landscape' },
	},
};

export function resolveFormat(format: string, orientation: string): PageFormat {
	const formatKey = format.toUpperCase();
	const orientationKey = orientation.toLowerCase();

	const orientations = FORMAT_MAP[formatKey];
	if (!orientations) {
		const available = Object.keys(FORMAT_MAP).join(', ');
		throw new Error(`Unknown page format "${format}". Available: ${available}`);
	}

	const pageFormat = orientations[orientationKey];
	if (!pageFormat) {
		throw new Error(`Unknown orientation "${orientation}". Use "portrait" or "landscape".`);
	}

	return pageFormat;
}
