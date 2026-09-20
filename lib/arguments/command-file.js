import {openSync, readSync, closeSync} from 'node:fs';
import {Buffer} from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import {whichCommandSync} from 'which-command';

/*
On Windows, `node:child_process` cannot natively run many kinds of files (`.cmd`, `.bat`, shebang scripts, ...): without a shell it resolves neither `PATHEXT` nor shebangs, and it does not escape arguments. We resolve the command to its full file path and escape its arguments ourselves, so those work without an explicit shell, just like on Unix, where the OS handles all of this for us.
*/
export const parseCommandFile = (file, commandArguments, options) => {
	// The arguments are cloned since a shebang interpreter might be prepended below, which must not mutate the caller's array
	const parsed = {file, commandArguments: [...commandArguments], options};

	// Under a shell, or on Unix, the OS resolves the file and escapes the arguments itself
	if (options.shell || process.platform !== 'win32') {
		return parsed;
	}

	return escapeWindowsCommand(parsed);
};

// Only `.exe` and `.com` files can be spawned directly; anything else needs `cmd.exe`
const directlyExecutableRegExp = /\.(?:com|exe)$/i;

// `.cmd` and `.bat` files are run through `cmd.exe`. npm cmd-shims re-expand `%*` through a second parse, so they need a second caret-escape. Ordinary batch files that read `%1`/`%~1` only go through one parse.
const batchFileRegExp = /\.(?:bat|cmd)$/i;

// Same path shape `cross-spawn` used: npm, Yarn and pnpm write cmd-shims under `node_modules/.bin`.
const cmdShimPathRegExp = /(?:^|[/\\])node_modules[/\\]\.bin[/\\][^/\\]+\.(?:cmd|bat)$/i;

// Npm cmd-shims look for a sibling `node.exe` and strip `.JS` from `PATHEXT` so the forwarded `%*` is not re-resolved as a script. That shape is the same whether the file lives in `.bin` or is a fixture copy such as `echo-shim.cmd`.
const cmdShimNodeRegExp = /%~?dp0%?\\node\.exe/i;
const cmdShimPathExtRegExp = /pathext=%pathext:;\.js;=;%/i;

export const isCmdShim = file => batchFileRegExp.test(file) && (cmdShimPathRegExp.test(file) || hasCmdShimContents(file));

const escapeWindowsCommand = parsed => {
	// Resolve the file to an absolute path, following its shebang to the interpreter if any
	const resolvedFile = resolveWithShebang(parsed);

	// A directly executable file is spawned by its resolved path, bypassing `cmd.exe` and its escaping
	if (resolvedFile !== undefined && directlyExecutableRegExp.test(resolvedFile)) {
		if (parsed.options.argv0 === undefined) {
			parsed.options.argv0 = parsed.file;
		}

		parsed.file = resolvedFile;
		return parsed;
	}

	/*
	`cmd.exe` treats CR and LF as command separators and offers no way to escape them, so allowing either would enable command injection.
	Reject them instead.
	*/
	for (const value of [parsed.file, ...parsed.commandArguments]) {
		assertNoLineBreak(value);
	}

	const isDoubleEscape = resolvedFile !== undefined && isCmdShim(resolvedFile);
	// POSIX separators must become Windows ones (`foo/bar` -> `foo\bar`), otherwise resolution always fails with ENOENT
	const escapedFile = escapeMetaChars(path.normalize(resolvedFile ?? parsed.file));
	const escapedArguments = parsed.commandArguments.map(argument => escapeArgument(argument, isDoubleEscape));
	const commandLine = `"${[escapedFile, ...escapedArguments].join(' ')}"`;

	// Let `node:child_process` pass the already-escaped command line through untouched
	parsed.options.windowsVerbatimArguments = true;
	return {
		file: process.env.comspec || 'cmd.exe',
		commandArguments: ['/d', '/s', '/c', commandLine],
		options: parsed.options,
	};
};

// Resolve the command's absolute path, then, if it is a shebang script, resolve its interpreter instead, since Windows cannot run shebangs natively
const resolveWithShebang = parsed => {
	const resolvedFile = resolvePath(parsed);
	const interpreter = resolvedFile !== undefined && readShebang(resolvedFile);
	if (!interpreter) {
		return resolvedFile;
	}

	// Run the interpreter with the script as its first argument, then resolve the interpreter's own path
	parsed.commandArguments.unshift(resolvedFile);
	parsed.file = interpreter;
	return resolvePath(parsed);
};

// Search `PATH` for the command, resolving its Windows executable extension via `PATHEXT`
const resolvePath = parsed => {
	const environment = parsed.options.env || process.env;
	const cwd = parsed.options.cwd ?? process.cwd();
	const environmentPathExt = getWindowsEnvironmentValue(environment, 'PATHEXT');
	const commandExtension = path.extname(parsed.file);
	// Commands with an explicit extension must be tried verbatim so shebang scripts work even when their extension is excluded from PATHEXT.
	const pathExt = commandExtension === '' ? environmentPathExt : `${commandExtension}${path.delimiter}${environmentPathExt ?? ''}`;
	if (hasWindowsPathSeparator(parsed.file)) {
		return whichCommandSync(path.resolve(cwd, parsed.file), {cwd, pathExt});
	}

	const searchPath = getWindowsEnvironmentValue(environment, 'PATH') ?? getWindowsEnvironmentValue(process.env, 'PATH') ?? '';
	const resolveOptions = {
		cwd,
		path: searchPath,
		pathExt,
	};

	return shouldSearchCurrentDirectory(environment) ? whichCommandSync(parsed.file, resolveOptions) : resolvePathDirectories(parsed.file, resolveOptions);
};

const hasWindowsPathSeparator = file => file.includes('/') || file.includes('\\') || file.includes(':');

const shouldSearchCurrentDirectory = environment => getWindowsEnvironmentValue(process.env, 'NODEFAULTCURRENTDIRECTORYINEXEPATH') === undefined && getWindowsEnvironmentValue(environment, 'NODEFAULTCURRENTDIRECTORYINEXEPATH') === undefined;

const resolvePathDirectories = (file, {cwd, path: searchPath, pathExt}) => {
	for (const directory of searchPath.split(path.delimiter)) {
		const unquotedDirectory = directory.length > 1 && directory.startsWith('"') && directory.endsWith('"') ? directory.slice(1, -1) : directory;
		if (unquotedDirectory === '') {
			continue;
		}

		const resolvedFile = whichCommandSync(path.resolve(cwd, unquotedDirectory, file), {cwd, pathExt});
		if (resolvedFile !== undefined) {
			return resolvedFile;
		}
	}
};

// Node sorts Windows environment keys and uses the first case-insensitive match when spawning.
const getWindowsEnvironmentValue = (environment, name) => {
	const environmentKey = Object.keys(environment).sort().find(key => key.toUpperCase() === name);
	return environmentKey === undefined ? undefined : environment[environmentKey];
};

const SHEBANG_BYTE_LENGTH = 150;
const CMD_SHIM_BYTE_LENGTH = 2048;

const readFilePrefix = (file, byteLength) => {
	const buffer = Buffer.alloc(byteLength);

	try {
		const fileDescriptor = openSync(file, 'r');
		try {
			const bytesRead = readSync(fileDescriptor, buffer, 0, byteLength, 0);
			return buffer.toString('utf8', 0, bytesRead);
		} finally {
			closeSync(fileDescriptor);
		}
	} catch {
		return undefined;
	}
};

const hasCmdShimContents = file => {
	const contents = readFilePrefix(file, CMD_SHIM_BYTE_LENGTH);
	return contents !== undefined && cmdShimNodeRegExp.test(contents) && cmdShimPathExtRegExp.test(contents);
};

// Read the file's first bytes to find its shebang interpreter, if it has one
const readShebang = file => {
	const contents = readFilePrefix(file, SHEBANG_BYTE_LENGTH);
	return contents === undefined ? undefined : parseShebang(contents);
};

const shebangRegExp = /^#!(?<line>.*)/;

/*
Extract the interpreter from a shebang line, e.g. `#!/usr/bin/env node` -> `node`.
*/
const parseShebang = contents => {
	const shebangLine = contents.match(shebangRegExp)?.groups.line.trim();
	if (!shebangLine) {
		return undefined;
	}

	const [interpreterPath, argument] = shebangLine.split(' ');
	const interpreter = interpreterPath.split('/').at(-1);
	if (interpreter === 'env') {
		return argument;
	}

	return argument ? `${interpreter} ${argument}` : interpreter;
};

const lineBreakRegExp = /[\n\r]/;

const assertNoLineBreak = value => {
	if (lineBreakRegExp.test(value)) {
		throw new TypeError(`The command and its arguments cannot contain a line break on Windows without a shell.\nThis would allow a command injection with \`cmd.exe\`.\nInvalid value: ${JSON.stringify(`${value}`)}`);
	}
};

// See https://web.archive.org/web/20241220221102/https://www.robvanderwoude.com/escapechars.php
// eslint-disable-next-line regexp/sort-character-class-elements
const metaCharsRegExp = /[()\][%!^"`<>&|;, *?]/g;

// Prefix every `cmd.exe` metacharacter with a caret to neutralize it
const escapeMetaChars = value => value.replaceAll(metaCharsRegExp, '^$&');

const backslashRunRegExp = /\\+/g;

const escapeArgument = (rawArgument, doubleEscape) => {
	/*
	Escape backslashes and double quotes for `cmd.exe`, following the algorithm at https://web.archive.org/web/20240930203505/https://qntm.org/cmd.

	A run of backslashes only needs doubling when it precedes a double quote, or the end of the argument since that becomes a double quote once the argument is wrapped below. Otherwise the backslashes would be taken as escaping that quote. Every double quote is then escaped in turn.

	Each backslash run is matched exactly once and consumed, so a long run cannot trigger the quadratic backtracking a naive pattern would, which would be a denial-of-service risk.
	*/
	const argument = `${rawArgument}`
		.replaceAll(backslashRunRegExp, (backslashes, offset, string) => {
			const nextCharacter = string[offset + backslashes.length];
			const isPrecedesDoubleQuote = nextCharacter === '"' || nextCharacter === undefined;
			return isPrecedesDoubleQuote ? backslashes.repeat(2) : backslashes;
		})
		.replaceAll('"', '\\"');

	// Wrap the whole argument in double quotes, then caret-escape the metacharacters, a second time when targeting a cmd-shim
	const escapedArgument = escapeMetaChars(`"${argument}"`);
	return doubleEscape ? escapeMetaChars(escapedArgument) : escapedArgument;
};
