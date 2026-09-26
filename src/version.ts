/**
 * Package version, importable without pulling in the MCP SDK.
 *
 * Deliberately a STATIC json import (not createRequire): bundlers (bun
 * build --compile) embed the value into single-file binaries, where a
 * runtime require('../package.json') would find nothing to read.
 */

import pkg from '../package.json' with { type: 'json' };

export const PKG_VERSION: string = pkg.version;
