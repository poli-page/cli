// K2: 1-20 characters, lowercase letters, digits and single inner hyphens,
// starting with a letter.
const ENVIRONMENT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ENVIRONMENT_NAME_MAX_LENGTH = 20;

/** Whether `name` is a well-formed environment name (K2). */
export function isValidEnvironmentName(name: string): boolean {
	return name.length <= ENVIRONMENT_NAME_MAX_LENGTH && ENVIRONMENT_NAME.test(name);
}
