/** Dev-only: emit a signed aimg token for thread 1. */
import { signToken } from '../src/util.js'
console.log('TOK=' + signToken({ a: 'aimg', th: 1 }, 3600))
process.exit(0)
