import { EntityId, EntityType, Timestamp } from "dcl-catalyst-commons";

export type FailedDeployment = {
  entityId: EntityId,
  entityType: EntityType,
  reason: string,
  moment: Timestamp,
}