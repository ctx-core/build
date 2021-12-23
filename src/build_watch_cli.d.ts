export function build_watch_cli():Promise<void>
export interface Op {
	name:'build'|'rm'
	args:[string, ...string[]]
}
export interface OpAdapter {
	id:string
	op:Op
	hash:string
}
