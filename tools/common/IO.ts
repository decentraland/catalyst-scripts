import fs from 'fs';
import { GLOBAL } from './Global';
import { Identity } from './types';

const LOG_PATH = () => GLOBAL.outputDir + "log.txt"
const FAILED_PATH = () => GLOBAL.outputDir + "failed.txt"
const RESULTS_PATH = () => GLOBAL.outputDir + "results.txt"

export function clearLogFiles() {
    fs.writeFileSync(LOG_PATH(), Buffer.from(""))
    fs.writeFileSync(FAILED_PATH(), Buffer.from(""))
    fs.writeFileSync(RESULTS_PATH(), Buffer.from(""))
}

export function log(message: string) {
    return fs.promises.appendFile(LOG_PATH(), Buffer.from(message + "\n"));
}

export function failed(message: string) {
    return fs.promises.appendFile(FAILED_PATH(), Buffer.from(message + "\n"));
}

export function results(message: string) {
    return fs.promises.appendFile(RESULTS_PATH(), Buffer.from(message + "\n"));
}

export function writeToFile(fileName: string, message: string, dir: string = GLOBAL.outputDir) {
    return fs.promises.writeFile(dir + fileName, Buffer.from(message));
}

export function readFile(filePath: string) {
    return fs.promises.readFile(filePath);
}

export function listFilesInDir(dirPath: string): Promise<string[]> {
    return fs.promises.readdir(dirPath);
}

export function getIdentity(identityFilePath: string): Identity {
    const identity = JSON.parse(fs.readFileSync(identityFilePath).toString())
    return identity
}