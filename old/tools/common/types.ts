export type ServerName = string
export type EntityId = FileHash
export type Timestamp = number
export type Pointer = string
export type FileHash = string
export type ServerAddress = string

export type EntityType = string;

export type AuditInfo = {
    version: string,
    deployedTimestamp: Timestamp
    authChain: any,
    overwrittenBy?: EntityId,
    isBlacklisted?: boolean,
    blacklistedContent?: FileHash[],
    originalMetadata?: { // This is used for migrations
        originalVersion: string,
        data: any,
    },
}

export type FailedDeployment = {
    entityId: EntityId,
    entityType: EntityType,
    reason: string,
    moment: Timestamp,
}

export interface Entity {
    id: string
    type: EntityType
    pointers: string[]
    timestamp: number
    content?: EntityContent[]
    metadata?: any
}

export type EntityBase = {
    entityType: EntityType,
    entityId: EntityId
}

export type EntityContent = {
    file: string,
    hash: string,
}

export type DeploymentEvent = EntityBase & {
    serverName: ServerName,
    timestamp: Timestamp,
}

export type DeploymentHistory = DeploymentEvent[]

export type PartialDeploymentHistory = {
    events: DeploymentEvent[],
    filters: {
        from?: Timestamp,
        to?: Timestamp,
        serverName?: ServerName,
    },
    pagination: {
        offset: number,
        limit: number,
        moreData: boolean,
    },
}

export type DeploymentData = {
    entityType: EntityType,
    entityId: EntityId,
    authChain: any,
    files: Map<string, Buffer>,
}

export type Identity = {
    ethAddress: string,
    privateKey: string
}