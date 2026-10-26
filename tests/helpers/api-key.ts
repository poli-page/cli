/** A well-formed API key bound to `environment`: `pp_<environment>_<32 lowercase hex>`. */
export function testApiKey(environment: string): string {
	return `pp_${environment}_0123456789abcdef0123456789abcdef`;
}
