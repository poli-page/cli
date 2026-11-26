/**
 * A read-only directory (chmod 0o500) blocks unlink only for a non-root
 * user on POSIX: root ignores directory write permission and Windows
 * applies no POSIX modes to directories.
 */
export const readOnlyDirBlocksUnlink =
	process.platform !== 'win32' && process.getuid?.() !== 0;
