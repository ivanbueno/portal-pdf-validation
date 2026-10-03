param prefix string = 'pdfval'
param location string = resourceGroup().location
param portalOrigin string = 'https://configure-after-first-deploy.invalid'
var suffix = uniqueString(resourceGroup().id)
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-runtime'
  location: location
}
// Never attach the API/maintenance identity to the worker, including for image pulls or scaling.
resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-worker'
  location: location
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${prefix}${suffix}'
  location: location
  // Private Link image pulls from the isolated worker environment require Premium.
  sku: { name: 'Premium' }
  properties: { adminUserEnabled: false }
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: '${prefix}${suffix}'
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
  }
}
resource blob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    cors: {
      corsRules: [
        {
          allowedOrigins: [portalOrigin]
          allowedMethods: ['PUT', 'OPTIONS']
          allowedHeaders: ['*']
          exposedHeaders: ['ETag']
          maxAgeInSeconds: 3600
        }
      ]
    }
  }
}
resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'documents'
  properties: { publicAccess: 'None' }
}
resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource queue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'validation'
}
resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource table 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'validation'
}
var roles = [
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
  '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
  'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'
]
resource dataRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for role in roles: {
    scope: storage
    name: guid(storage.id, identity.id, role)
    properties: {
      principalId: identity.properties.principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role)
    }
  }
]
resource pullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identity.id, 'pull')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}
resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${prefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}
module workerAccess './worker-access.bicep' = {
  name: '${prefix}-worker-access'
  params: {
    prefix: prefix
    storageName: storage.name
    registryName: registry.name
  }
  dependsOn: [workerIdentity, container, queue, table]
}
module workerNetwork './worker-network.bicep' = {
  name: '${prefix}-worker-network'
  params: {
    prefix: prefix
    location: location
    storageName: storage.name
    registryName: registry.name
    logsName: logs.name
  }
}
output identityId string = identity.id
output workerIdentityId string = workerIdentity.id
output workerClientId string = workerIdentity.properties.clientId
output storageName string = storage.name
output storageId string = storage.id
output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output environmentId string = environment.id
output workerEnvironmentId string = workerNetwork.outputs.environmentId
output logsId string = logs.id
