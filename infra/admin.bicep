param namePrefix string
param location string = resourceGroup().location

var names = loadJsonContent('./names.json')

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-${names.runtimeIdentity}'
  location: location
}
// Never attach the API/maintenance identity to the worker, including for image pulls or scaling.
resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-${names.workerIdentity}'
  location: location
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: replace('${namePrefix}-${names.registry}', '-', '')
  location: location
  // Private Link image pulls from the isolated worker environment require Premium.
  sku: { name: 'Premium' }
  properties: { adminUserEnabled: false }
}
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
  name: '${namePrefix}-${names.logs}'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource workerPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, workerIdentity.id, 'pull')
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}
output identityId string = identity.id
output runtimeClientId string = identity.properties.clientId
output workerIdentityId string = workerIdentity.id
output workerClientId string = workerIdentity.properties.clientId
output registryName string = registry.name
output registryId string = registry.id
output registryServer string = registry.properties.loginServer
output logsId string = logs.id
