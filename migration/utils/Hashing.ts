import CID from 'cids'
import multihashing from 'multihashing-async';

export class Hashing {

    static async calculateHashes(files: Map<string, Buffer>): Promise<{file: string, hash: FileHash}[]> {
        return Promise.all(Array.from(files.entries())
            .map(async ([file, content]) => ({ file, hash: await this.calculateBufferHash(content) })))
    }

    static async calculateBufferHash(buffer: Buffer): Promise<FileHash> {
        const hash = await multihashing(buffer, "sha2-256")
        return new CID(0, 'dag-pb', hash).toBaseEncodedString()
    }
}

export type FileHash = string