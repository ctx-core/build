import { exec } from '@ctx-core/child_process'
import { param_r_ } from '@ctx-core/cli-args'
import CheapWatch from 'cheap-watch'
import { queue_ } from 'ctx-core/queue'
import { fdir } from 'fdir'
import { readFile, rm as fs_rm, stat } from 'fs/promises'
import yaml from 'js-yaml'
import { minimatch } from 'minimatch'
import ora from 'ora'
import { basename, dirname, join, resolve } from 'path'
import Rusha from 'rusha'
/** @typedef {import('./index.d.ts').Op} */
/** @typedef {import('./index.d.ts').OpAdapter} */
/** @typedef {import('ora').Ora} */
export async function build_watch_cli() {
	const param_r = param_r_(process.argv.slice(2), {
		help: '-h, --help',
		force: '-f, --force',
		ignore_a: '-i, --ignore',
		op_threads_a: '-o, --op-threads',
		pnpm_workspace_path_a: '-p, --pnpm-workspace-path',
		sync_threads_a: '-s, --sync-threads',
		verbose: '-v, --verbose',
	})
	const help = !!param_r.help
	const force = !!param_r.force
	const verbose = !!param_r.verbose
	/** @type {string[]} */
	const ignore_a = param_r.ignore_a || []
	const pnpm_workspace_path = param_r.pnpm_workspace_path_a?.[0] || './pnpm-workspace.yaml'
	if (help) {
		console.info(`
Usage: build-watch [-f,--force]

Options:

-h, --help		This help message
-f, --force		Force *.ts,*.tsx to be built on startup
-v, --verbose	Verbose logs
	`.trim())
	}
	const ops = { build, rm }
	const ts_dist_ext_a = ['.js', '.jsx', '.js.map', '.jsx.map', '.svelte', '.mjs', '.cjs', '.js',]
	const ts_src_ext_a = ['.ts', '.tsx', '.svelte', '.mjs', '.cjs', '.js',]
	const op_threads = parseInt(param_r.op_threads_a?.[0] || '8')
	const op_queue = queue_(op_threads)
	const sync_threads = parseInt(param_r.sync_threads_a?.[0] || '1')
	const sync_queue = queue_(sync_threads)
	/** @type {OpAdapter[]} */
	const pending_op_adapter_a = []
	/** @type {Set<string>} */
	const pending_id_set = new Set()
	const root_dir = resolve('.')
	const pnpm_workspace = /** @type {{ packages:string[] } */ await yaml.load(
		await readFile(pnpm_workspace_path).then($=>$.toString()))
	/** @type {string[]} */
	const pnpm_workspace_package_path_a = pnpm_workspace.packages.map(package_path=>join(root_dir, package_path))
	/** @type {string[]} */
	const pkg_path_a = await new fdir().glob(...pnpm_workspace_package_path_a)
		.onlyDirs()
		.withFullPaths()
		.crawl(process.cwd())
		.withPromise()
	/** @type {Stats[]} */
	const pkg_dir_stat_a = (
		await Promise.all(
			pkg_path_a.map(package_path=>
				file_stat_(join(package_path, 'package.json'))
			)
		)
	)
	/** @type {string[]} */
	const pkg_dir_a = pkg_path_a
		.filter((_, i)=>pkg_dir_stat_a[i])
		.sort((i0_path, i1_path)=>i1_path.length - i0_path.length)
	const pkg_src_dir_a = pkg_path_a.map(package_path=>join(package_path, 'src'))
	const pkg_dist_dir_a = pkg_path_a.map(package_path=>join(package_path, 'lib'))
	const all_ts_src_path_a = await path_a_(pkg_src_dir_a.map(ts_src_path=>`${ts_src_path}/**/*.(ts|tsx)`))
	const d_ts_regex = /\.d\.ts$/
	const ts_src_path_a = all_ts_src_path_a.filter(ts_path=>!d_ts_regex.test(ts_path))
	for (const asset_ext of ts_dist_ext_a) {
		await sync_dist_to_src(
			'init',
			await path_a_(pkg_dist_dir_a.map(pkg_dist_dir=>`${pkg_dist_dir}/**/*${asset_ext}`)),
			asset_ext
		)
	}
	for (const ts_src_ext of ts_src_ext_a) {
		await sync_src_to_dist(
			'init',
			await path_a_(pkg_src_dir_a.map(ts_src_path=>`${ts_src_path}/**/*${ts_src_ext}`)),
			ts_src_ext,
			force
		)
	}
	await run_op_a()
	/**
	 * @param {string} path
	 */
	const filter = ({ path })=>{
		const full_path = join(root_dir, path)
		return !!ts_src_path_a.find(src_path=>~src_path.indexOf(full_path))
	}
	/** @type {CheapWatch} */
	await new CheapWatch({ dir: resolve('.'), filter, debounce: 50 })
		.on('+',
			/**
			 * @param {string} path
			 * @param {Stats} stats
			 * @returns {Promise<void>}
			 */
			async ({ path, stats })=>{
				if (should_ignore_path_(path)) return
				if (verbose) {
					console.info('+', path)
				}
				if (stats.isDirectory()) {
					if (!pending_id_set.has(path)) {
						await schedule_sync_src_dist(path)
					}
				}
			})
		.on('-',
			/**
			 * @param {string} path
			 * @param {Stats} stats
			 * @returns {Promise<void>}
			 */
			async ({ path, stats })=>{
				if (should_ignore_path_(path)) return
				if (verbose) {
					console.info('-', path)
				}
				if (stats.isDirectory()) {
					if (!pending_id_set.has(path)) {
						await schedule_sync_src_dist(path)
					}
				}
			})
		.init()
	console.info('started...')
	/**
	 * @param {string} path
	 */
	function should_ignore_path_(path) {
		return ignore_a.some(ignore=>minimatch(path, ignore))
	}
	/**
	 * @param {string} relative_path
	 * @return {Promise<void>}
	 */
	async function schedule_sync_src_dist(relative_path) {
		await sync_queue.add(async ()=>{
			const absolute_path = join(root_dir, relative_path)
			const tsconfig_dir = pkg_dir_a.find(tsconfig_dir=>~absolute_path.indexOf(tsconfig_dir))
			for (const ts_dist_ext of ts_dist_ext_a) {
				await sync_dist_to_src(relative_path, await path_a_([`${tsconfig_dir}/lib/**/*${ts_dist_ext}`]), ts_dist_ext)
			}
			for (const ts_src_ext of ts_src_ext_a) {
				await sync_src_to_dist(relative_path, await path_a_([`${tsconfig_dir}/src/**/*${ts_src_ext}`]), ts_src_ext)
			}
			await run_op_a()
		})
	}
	/**
	 * @return {Promise<void>}
	 */
	async function run_op_a() {
		/** @type {Ora} */
		let spinner
		if (!verbose) {
			spinner = ora().start()
		}
		/** @type {Record<string, string[]>} */
		const hash_r_id_a = {}
		/** @type {Set <string>} */
		const op_hash_set = new Set()
		/** @type {OpAdapter[]} */
		const op_adapter_a = []
		for (const op_adapter of pending_op_adapter_a) {
			const { id, hash } = op_adapter
			hash_r_id_a[hash] = hash_r_id_a[hash] || []
			hash_r_id_a[hash].push(id)
			pending_id_set.add(id)
			if (!op_hash_set.has(hash)) {
				op_hash_set.add(hash)
				op_adapter_a.push(op_adapter)
			}
		}
		pending_op_adapter_a.length = 0
		let current_count = 0
		const total_count = op_adapter_a.length
		try {
			await Promise.all(
				op_adapter_a.map(op_adapter=>op_queue.add(
					async ()=>{
						try {
							const { op, hash } = op_adapter
							await ops[op.name](op.args[0], ...op.args.slice(1))
							for (const id of hash_r_id_a[hash]) {
								pending_id_set.delete(id)
							}
							if (!verbose) {
								spinner.text = spinner_text_(current_count, total_count)
							}
						} catch (e) {
							console.error(e)
						} finally {
							current_count += 1
						}
					})))
			op_adapter_a.length = 0
			pending_id_set.clear()
		} finally {
			if (!verbose) {
				spinner.stop()
			}
		}
		/**
		 * @param {number} current_count
		 * @param {number} total_count
		 * @returns {string}
		 */
		function spinner_text_(current_count, total_count) {
			return `${current_count} of ${total_count}`
		}
	}
	/**
	 * @param {string[]} glob_a
	 * @returns {Promise<string[]>}
	 */
	async function path_a_(glob_a) {
		return await new fdir().glob(...glob_a)
			.withFullPaths()
			.crawl(process.cwd())
			.withPromise()
	}
	/**
	 * @param {string} id
	 * @param {string[]} dist_path_a
	 * @param {string} dist_ext
	 * @returns {Promise<void>}
	 */
	async function sync_dist_to_src(id, dist_path_a, dist_ext) {
		for (const dist_path of dist_path_a) {
			if (should_ignore_path_(dist_path)) continue
			if (~dist_path.indexOf('/src/')) continue
			const tsconfig_dir = pkg_dir_a.find(tsconfig_dir=>~dist_path.indexOf(tsconfig_dir))
			const dist_relative_path = dist_path
				.replace(`${tsconfig_dir}/`, '')
				.replace(/^lib\//, '')
			const src_path_a = ts_src_ext_a.map(source_ext=>
				join(
					tsconfig_dir, 'src', dirname(dist_relative_path),
					`${basename(dist_relative_path, dist_ext)}${source_ext}`
				)
			)
			/** @type {(Stats|null)[]} */
			const src_stat_a = await Promise.all(
				src_path_a.map(src_path=>file_stat_(src_path))
			)
			if (src_stat_a.some(exists=>exists)) {
				const idx = src_stat_a.findIndex(src_stat=>src_stat)
				const src_stat = src_stat_a[idx]
				const dist_stat = await file_stat_(dist_path)
				if (src_stat?.mtime > dist_stat?.mtime) {
					if (verbose) {
						console.info('sync_dist_to_src|build', { dist_path })
					}
					pending_op_adapter_a.push(
						op_adapter_(id, { name: 'build', args: [tsconfig_dir] })
					)
				}
			} else {
				if (!await file_stat_(join(tsconfig_dir, 'src', dist_relative_path))) {
					pending_op_adapter_a.push(
						op_adapter_(id, { name: 'rm', args: [dist_path] })
					)
				}
			}
		}
	}
	/**
	 * @param {string} id
	 * @param {string[]} src_path_a
	 * @param {string} src_ext
	 * @returns {Promise<void>}
	 */
	async function sync_src_to_dist(id, src_path_a, src_ext, force = false) {
		for (const src_path of src_path_a) {
			if (should_ignore_path_(src_path)) continue
			if (~src_path.indexOf('/lib/')) continue
			const tsconfig_dir = pkg_dir_a.find(tsconfig_dir=>~src_path.indexOf(tsconfig_dir))
			const src_relative_path = src_path.replace(join(tsconfig_dir, 'src'), '')
			const dist_relative_path_a = ts_dist_ext_a
				.filter(ts_dist_ext=>
					src_ext === '.tsx'
						? !~['.js', '.js.map'].indexOf(ts_dist_ext)
						: !~['.jsx', '.jsx.map'].indexOf(ts_dist_ext)
				).map(asset_ext=>
					`${dirname(src_relative_path)}${basename(src_relative_path, src_ext)}${asset_ext}`)
			const dist_base_path = join(tsconfig_dir, 'lib')
			const dist_path_a = dist_relative_path_a.map((dist_relative_path)=>
				join(dist_base_path, dist_relative_path))
			/** @type {(Stats|null)[]} */
			const dist_stat_a = await Promise.all(
				dist_path_a.map(dist_path=>file_stat_(dist_path))
			)
			if (force || dist_stat_a.every(exists=>!exists)) {
				if (verbose) {
					console.info('sync_src_to_dist|force|missing_dist', {
						src_path,
					})
				}
				pending_op_adapter_a.push(
					op_adapter_(id, { name: 'build', args: [tsconfig_dir] })
				)
			} else {
				const src_stat = await file_stat_(src_path)
				const dist_stat = dist_stat_a.find(dist_stat=>src_stat?.mtime > dist_stat?.mtime)
				if (dist_stat) {
					if (verbose) {
						console.info('sync_src_to_dist|build|mtime', {
							src_path,
							'src_stat?.mtime': src_stat?.mtime,
							'dist_stat?.mtime': dist_stat?.mtime,
						})
					}
					pending_op_adapter_a.push(
						op_adapter_(id, { name: 'build', args: [tsconfig_dir] })
					)
				}
			}
		}
	}
	/**
	 * @param {string} id
	 * @param {Op} op
	 * @returns {OpAdapter}
	 */
	function op_adapter_(id, op) {
		return {
			id, op, hash: Rusha.createHash().update(JSON.stringify(op)).digest('hex')
		}
	}
	/**
	 * @param {string} path
	 * @returns {Promise<Stats|null>}
	 */
	async function file_stat_(path) {
		try {
			return await stat(path)
		} catch (e) {
			return null
		}
	}
	/**
	 * @param {string} args
	 * @returns {Promise<void>}
	 */
	async function rm(path) {
		await fs_rm(path)
		if (verbose) {
			console.info(`rm ${path}`)
		}
	}
	/**
	 * @param {string} tsconfig_dir
	 * @returns {Promise<void>}
	 */
	async function build(tsconfig_dir) {
		try {
			const cmd = `(cd ${tsconfig_dir} && pnpm run build)`
			await exec(cmd)
			if (verbose) {
				console.info(cmd)
			}
		} catch (e) {
			console.error(e.cmd)
			console.error(e.stdout)
			throw new Error('build error')
		}
	}
}
