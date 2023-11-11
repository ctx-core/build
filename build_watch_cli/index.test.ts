import { is } from 'uvu/assert'
import { test } from 'uvu'
import { build_watch_cli } from '../index.js'
test('build_watch_cli|loads', ()=>{
	is(typeof build_watch_cli, 'function')
})
test.run()
