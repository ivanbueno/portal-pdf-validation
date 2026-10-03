param namePrefix string
param location string = resourceGroup().location
param portalOrigin string
param adminResourceGroupName string

var names = loadJsonContent('./names.json')

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  scope: resourceGroup(adminResourceGroupName)
  name: '${namePrefix}-${names.runtimeIdentity}'
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: replace('${namePrefix}-${names.storage}', '-', '')
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

module workerAccess './worker-access.bicep' = {
  name: '${namePrefix}-${names.workerAccessDeployment}'
  params: {
    namePrefix: namePrefix
    storageName: storage.name
    adminResourceGroupName: adminResourceGroupName
  }
  dependsOn: [container, queue, table]
}
output storageName string = storage.name
output storageId string = storage.id
