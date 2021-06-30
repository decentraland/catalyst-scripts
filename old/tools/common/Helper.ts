import * as cliProgress from 'cli-progress';
import asyncPool from "tiny-async-pool"
import { EntityBase, EntityType, EntityId } from './types';
import { ENTITY_TYPES, GLOBAL, CHUNK_SIZE } from './Global';
import { log } from './IO';

export async function executeWithRetries<T>(executor: () => Promise<T>, errorMessage: string, retries: number = GLOBAL.retries): Promise<T> {
    while(retries > 0) {
        try {
            return await executor()
        } catch (error) {
            await log(`${errorMessage}. Retries left: ${retries - 1}. Error message:\n${error}`)
            if (retries > 1) {
                // Choose between 1 and 10 seconds to wait
                const seconds = 1 + Math.floor(Math.random() * 10);
                await sleep(seconds * 1000)
                retries--;
            } else {
                throw new Error(errorMessage)
                // process.exit()
            }
        }
    }
    throw new Error(`Shouldn't get here`)
}

export async function executeWithProgressBar<T, K>(detail: string, array: Array<T>, iterator: (T) => Promise<K>, concurrency: number =  GLOBAL.concurrency): Promise<K[]> {
    const bar = new cliProgress.SingleBar({format: `${detail.padEnd(22, ' ')}: [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}`});
    bar.start(array.length, 0);

    const result = await asyncPool(concurrency, array, async (value) => {
        const result: K = await iterator(value)
        bar.increment(1)
        return result
    });

    bar.stop()

    return result
}

export function splitIntoChunks<T>(array: T[], chunkSize : number) {
    let result: T[][] = [];
    for (let i = 0,len = array.length; i < len; i += chunkSize)
        result.push(array.slice(i, i + chunkSize));
    return result;
}

export function areObjectsTheSame<T>(object1: T, object2: T): boolean {
    return JSON.stringify(object1, Object.keys(object1).sort()) === JSON.stringify(object2, Object.keys(object2).sort())
}

export async function filterAsync<T>(array: T[], predicate: (value: T) => Promise<boolean>) {
    const results = await Promise.all(array.map(async value => ({ value, result: await predicate(value) })))
    return results.filter(({ result }) => result)
        .map(({ value }) => value)
}

export async function mapAsync<T, K>(array: T[], mapping: (value: T) => Promise<K>) {
    return await Promise.all(array.map(value => mapping(value)))
}

export function chooseRandom<T>(array: T[], ) {
    const shuffled = shuffleArray(array)
    // return shuffled.slice(, i)
}

function shuffleArray<T>(input: T[]) {
    const array = input.slice()
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/** Take a list of entities and split it into chunks */
export function createEntityChunks(entities: EntityBase[]): EntityBase[][] {
    const entitiesByType: Map<EntityType, Set<EntityId>> = new Map(ENTITY_TYPES.map(type => [type, new Set()]));
    entities.forEach(({ entityType, entityId }) => entitiesByType.get(entityType)!!.add(entityId));

    let entitiesChunks: EntityBase[][] = [];
    for (const [entityType, entityIds] of entitiesByType.entries()) {
        const entities = Array.from(entityIds.values())
            .map(entityId => ({ entityType, entityId }));
        entitiesChunks = entitiesChunks.concat(splitIntoChunks(entities, CHUNK_SIZE));
    }

    return entitiesChunks;
}

export function getServerName(url: string) {
    let hostname: string;
    //find & remove protocol (http, ftp, etc.) and get hostname

    if (url.indexOf("//") > -1) {
        hostname = url.split('/')[2];
    }
    else {
        hostname = url.split('/')[0];
    }

    //find & remove port number
    hostname = hostname.split(':')[0];
    //find & remove "?"
    hostname = hostname.split('?')[0];

    return hostname;
}