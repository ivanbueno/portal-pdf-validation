// The worker receives only the storage operations used by its queue/claim/report loop.
// Conditions are defense in depth; a shared worker identity is not per-document isolation.
param namePrefix string
param storageName string
param adminResourceGroupName string

var names = loadJsonContent('./names.json')

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  scope: resourceGroup(adminResourceGroupName)
  name: '${namePrefix}-${names.workerIdentity}'
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageName
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}
resource documents 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobService
  name: 'documents'
}
resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}
resource validationQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' existing = {
  parent: queueService
  name: 'validation'
}
resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}
resource validationTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' existing = {
  parent: tableService
  name: 'validation'
}
resource blobRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, namePrefix, 'worker-blobs')
  properties: {
    roleName: '${namePrefix}-${names.workerBlobRole}'
    description: 'Read submitted PDF snapshots and write validation reports; constrained by assignment conditions.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: []
        notActions: []
        dataActions: [
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'
        ]
        notDataActions: []
      }
    ]
  }
}
resource blobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: documents
  name: guid(documents.id, workerIdentity.id, blobRole.id)
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobRole.id
    conditionVersion: '2.0'
    // Explicit operation allowlist: Blob.List never receives an exemption. Snapshot presence
    // excludes the mutable base blob. StringLike '*' crosses '/', so the literal reports
    // namespace and JSON/XML extensions are required, not just a count of wildcard segments.
    // Source: https://learn.microsoft.com/azure/storage/blobs/storage-auth-abac-attributes
    condition: '''
(
  @Environment[isPrivateLink] BoolEquals true
  AND
  (
    (
      ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'}
      AND NOT SubOperationMatches{'Blob.List'}
      AND @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringLike '*/*/input.pdf'
      AND Exists @Request[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:snapshot]
    )
    OR
    (
      ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'}
      AND
      (
        @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringLike '*/*/reports/*.json'
        OR @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringLike '*/*/reports/*.xml'
      )
    )
  )
)
'''
  }
}

resource queueRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, namePrefix, 'worker-queue')
  properties: {
    roleName: '${namePrefix}-${names.workerQueueRole}'
    description: 'Inspect queue length for event scaling, and peek, receive or delete messages; no message writes.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        // KEDA reads approximate_message_count with Get Queue Metadata.
        actions: ['Microsoft.Storage/storageAccounts/queueServices/queues/read']
        notActions: []
        dataActions: [
          'Microsoft.Storage/storageAccounts/queueServices/queues/messages/read'
          'Microsoft.Storage/storageAccounts/queueServices/queues/messages/process/action'
        ]
        notDataActions: []
      }
    ]
  }
}
resource queueAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: validationQueue
  name: guid(validationQueue.id, workerIdentity.id, queueRole.id)
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: queueRole.id
  }
}

resource tableRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, namePrefix, 'worker-table')
  properties: {
    roleName: '${namePrefix}-${names.workerTableRole}'
    description: 'Read and update existing validation claims and status; no entity insert/delete or table management.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: []
        notActions: []
        dataActions: [
          'Microsoft.Storage/storageAccounts/tableServices/tables/entities/read'
          'Microsoft.Storage/storageAccounts/tableServices/tables/entities/update/action'
        ]
        notDataActions: []
      }
    ]
  }
}
resource tableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: validationTable
  name: guid(validationTable.id, workerIdentity.id, tableRole.id)
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: tableRole.id
  }
}
