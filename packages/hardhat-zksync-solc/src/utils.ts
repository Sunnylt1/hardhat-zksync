import semver from 'semver';
import crypto from 'crypto';
import { SolcConfig } from 'hardhat/types';
import fse from 'fs-extra';
import lockfile from 'proper-lockfile';
import fs from 'fs';
import path from 'path';
import util from 'util';
import type { Dispatcher } from 'undici';
import { ZkSyncSolcPluginError } from './errors';
import { CompilerVersionInfo } from './compile/downloader';
import { CompilerOutputSelection, MissingLibrary, ZkSolcConfig } from './types';
import { ZKSOLC_COMPILERS_SELECTOR_MAP, SOLCJS_EXECUTABLE_CODE, DEFAULT_TIMEOUT_MILISECONDS } from './constants';

const TEMP_FILE_PREFIX = 'tmp-';

export function filterSupportedOutputSelections(
    outputSelection: CompilerOutputSelection,
    zkCompilerVersion: string,
): CompilerOutputSelection {
    const filteredOutputSelection: CompilerOutputSelection = {};
    const versionComponents = getVersionComponents(zkCompilerVersion);
    let supportedOutputSelections: string[];

    switch (true) {
        case versionComponents[0] <= 1 && versionComponents[1] <= 3 && versionComponents[2] <= 5:
            supportedOutputSelections = ZKSOLC_COMPILERS_SELECTOR_MAP['1.3.5'];
            break;
        default:
            supportedOutputSelections = [...ZKSOLC_COMPILERS_SELECTOR_MAP['1.3.5'], 'metadata', 'userdoc', 'devdoc'];
            break;
    }

    for (const [file, contractSelection] of Object.entries(outputSelection)) {
        filteredOutputSelection[file] = {};

        for (const [contract, outputs] of Object.entries(contractSelection)) {
            filteredOutputSelection[file][contract] = outputs.filter((output) =>
                supportedOutputSelections.includes(output),
            );
        }
    }

    return filteredOutputSelection;
}

export function updateCompilerConf(compiler: SolcConfig, zksolc: ZkSolcConfig) {
    const [major, minor] = getVersionComponents(compiler.version);
    if (major === 0 && minor < 8 && zksolc.settings.forceEvmla) {
        console.warn('zksolc solidity compiler versions < 0.8 work with forceEvmla enabled by default');
    }
    const settings = compiler.settings || {};

    // Override the default solc optimizer settings with zksolc optimizer settings.
    compiler.settings = { ...settings, optimizer: { ...zksolc.settings.optimizer } };

    // Remove metadata settings from solidity settings.
    delete compiler.settings.metadata;
    // Override the solc metadata settings with zksolc metadata settings.
    if (zksolc.settings.metadata) {
        compiler.settings.metadata = { ...zksolc.settings.metadata };
    }

    // zkSolc supports only a subset of solc output selections
    compiler.settings.outputSelection = filterSupportedOutputSelections(
        compiler.settings.outputSelection,
        zksolc.version,
    );
}

export function zeroxlify(hex: string): string {
    hex = hex.toLowerCase();
    return hex.slice(0, 2) === '0x' ? hex : `0x${hex}`;
}

export function isURL(url: string): boolean {
    try {
        const locator = new URL(url);
        return locator.protocol === 'http:' || locator.protocol === 'https:';
    } catch (e) {
        return false;
    }
}

export function sha1(str: string): string {
    return crypto.createHash('sha1').update(str).digest('hex');
}

export function saltFromUrl(url: string): string {
    return sha1(url);
}

export function getZksolcUrl(repo: string, version: string, isRelease: boolean = true): string {
    // @ts-ignore
    const platform = { darwin: 'macosx', linux: 'linux', win32: 'windows' }[process.platform];
    // @ts-ignore
    const toolchain = { linux: '-musl', win32: '-gnu', darwin: '' }[process.platform];
    const arch = process.arch === 'x64' ? 'amd64' : process.arch;
    const ext = process.platform === 'win32' ? '.exe' : '';

    if (isRelease) {
        return `${repo}/releases/download/v${version}/zksolc-${platform}-${arch}${toolchain}-v${version}${ext}`;
    }

    return `${repo}/raw/main/${platform}-${arch}/zksolc-${platform}-${arch}${toolchain}-v${version}${ext}`;
}

export function pluralize(n: number, singular: string, plural?: string) {
    if (n === 1) {
        return singular;
    }

    if (plural !== undefined) {
        return plural;
    }

    return `${singular}s`;
}

export function getVersionComponents(version: string): number[] {
    const versionComponents = version.split('.');
    return [parseInt(versionComponents[0], 10), parseInt(versionComponents[1], 10), parseInt(versionComponents[2], 10)];
}

export function isVersionInRange(version: string, versionInfo: CompilerVersionInfo): boolean {
    const latest = versionInfo.latest;
    const minVersion = versionInfo.minVersion;

    return semver.gte(version, minVersion) && semver.lte(version, latest);
}

// Generate SolcJS executable code
export function generateSolcJSExecutableCode(solcJsPath: string, workingDir: string): string {
    return SOLCJS_EXECUTABLE_CODE.replace(/SOLCJS_PATH/g, solcJsPath).replace(/WORKING_DIR/g, workingDir);
}

// Find all the libraries that are missing from the contracts
export function findMissingLibraries(zkSolcOutput: any): Set<string> {
    const missingLibraries = new Set<string>();

    for (const filePath in zkSolcOutput.contracts) {
        if (!filePath) continue;
        for (const contractName in zkSolcOutput.contracts[filePath]) {
            if (!contractName) continue;
            const contract = zkSolcOutput.contracts[filePath][contractName];
            if (contract.missingLibraries && contract.missingLibraries.length > 0) {
                contract.missingLibraries.forEach((library: string) => {
                    missingLibraries.add(library);
                });
            }
        }
    }

    return missingLibraries;
}

export function mapMissingLibraryDependencies(zkSolcOutput: any, missingLibraries: Set<string>): MissingLibrary[] {
    const dependencyMap = new Array<MissingLibrary>();

    missingLibraries.forEach((library) => {
        const [libFilePath, libContractName] = library.split(':');
        if (zkSolcOutput.contracts[libFilePath] && zkSolcOutput.contracts[libFilePath][libContractName]) {
            const contract = zkSolcOutput.contracts[libFilePath][libContractName];
            if (contract.missingLibraries) {
                dependencyMap.push({
                    contractName: libContractName,
                    contractPath: libFilePath,
                    missingLibraries: contract.missingLibraries,
                });
            }
        }
    });

    return dependencyMap;
}

// Get or create the libraries file. If the file doesn't exist, create it with an empty array
const getOrCreateLibraries = async (filePath: string): Promise<any[]> => {
    // Ensure the file exists
    if (!(await fse.pathExists(filePath))) {
        await fse.outputFile(filePath, '[]'); // Initialize with an empty array
    }

    // Return the file's content
    return await fse.readJSON(filePath);
};

// Write missing libraries to file and lock the file while writing
export const writeLibrariesToFile = async (filePath: string, libraries: any[]): Promise<void> => {
    try {
        let existingLibraries = await getOrCreateLibraries(filePath); // Ensure that the file exists
        await lockfile.lock(filePath, { retries: { retries: 10, maxTimeout: 1000 } });

        existingLibraries = await getOrCreateLibraries(filePath); // Read again after locking
        const combinedLibraries = [...existingLibraries, ...libraries];
        fse.outputFileSync(filePath, JSON.stringify(combinedLibraries, null, 4));
    } catch (e) {
        throw new ZkSyncSolcPluginError(`Failed to write missing libraries file: ${e}`);
    } finally {
        await lockfile.unlock(filePath);
    }
};

function resolveTempFileName(filePath: string): string {
    const { dir, ext, name } = path.parse(filePath);

    return path.format({
        dir,
        ext,
        name: `${TEMP_FILE_PREFIX}${name}`,
    });
}

export async function download(
    url: string,
    filePath: string,
    userAgent: string,
    version: string,
    timeoutMillis = 10000,
    extraHeaders: { [name: string]: string } = {},
) {
    const { pipeline } = await import('stream');
    const { getGlobalDispatcher, request } = await import('undici');
    const streamPipeline = util.promisify(pipeline);

    const dispatcher: Dispatcher = getGlobalDispatcher();

    // Fetch the url
    const response = await request(url, {
        dispatcher,
        headersTimeout: timeoutMillis,
        maxRedirections: 10,
        method: 'GET',
        headers: {
            ...extraHeaders,
            'User-Agent': `${userAgent} ${version}`,
        },
    });

    if (response.statusCode >= 200 && response.statusCode <= 299) {
        const tmpFilePath = resolveTempFileName(filePath);
        await fse.ensureDir(path.dirname(filePath));

        await streamPipeline(response.body, fs.createWriteStream(tmpFilePath));
        return fse.move(tmpFilePath, filePath, { overwrite: true });
    }

    // undici's response bodies must always be consumed to prevent leaks
    const text = await response.body.text();

    // eslint-disable-next-line
    throw new Error(
        `Failed to download ${url} - ${response.statusCode} received. ${text}`
    );
}

export async function getLatestRelease(
    owner: string,
    repo: string,
    userAgent: string,
    timeout: number = DEFAULT_TIMEOUT_MILISECONDS,
): Promise<any> {
    const url = `https://github.com/${owner}/${repo}/releases/latest`;
    const redirectUrlPattern = `https://github.com/${owner}/${repo}/releases/tag/v`;

    const { request } = await import('undici');

    const response = await request(url, {
        headersTimeout: timeout,
        maxRedirections: 0,
        method: 'GET',
        headers: {
            'User-Agent': `${userAgent}`,
        },
    });

    // Check if the response is a redirect
    if (response.statusCode >= 300 && response.statusCode < 400) {
        // Get the URL from the 'location' header
        if (response.headers.location) {
            // Check if the redirect URL matches the expected pattern
            if (response.headers.location.startsWith(redirectUrlPattern)) {
                // Extract the tag from the redirect URL
                return response.headers.location.substring(redirectUrlPattern.length);
            }

            throw new ZkSyncSolcPluginError(`Unexpected redirect URL: ${response.headers.location} for URL: ${url}`);
        } else {
            // Throw an error if the 'location' header is missing in a redirect response
            throw new ZkSyncSolcPluginError(`Redirect location not found for URL: ${url}`);
        }
    } else {
        // Throw an error for non-redirect responses
        throw new ZkSyncSolcPluginError(`Unexpected response status: ${response.statusCode} for URL: ${url}`);
    }
}

export async function saveDataToFile(data: any, targetPath: string) {
    await fse.ensureDir(path.dirname(targetPath));
    await fse.writeJSON(targetPath, data, { spaces: 2 });
}
