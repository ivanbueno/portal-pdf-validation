targetScope = 'subscription'

@description('Environment token: 1–5 lowercase letters/digits, beginning with a letter.')
@minLength(1)
@maxLength(5)
param env string = 'prod'
@description('Project token: 1–10 lowercase letters/digits, beginning with a letter. Must make storage/registry names globally unique.')
@minLength(1)
@maxLength(10)
param project string = 'pdfportal'
param location string
param portalOrigin string = 'https://configure-after-first-deploy.invalid'

var namePrefix = '${env}-${project}'
var names = loadJsonContent('./names.json')

resource adminGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: '${namePrefix}-${names.adminGroup}'
  location: location
}

resource netGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: '${namePrefix}-${names.netGroup}'
  location: location
}

resource appGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: '${namePrefix}-${names.appGroup}'
  location: location
}

resource dataGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: '${namePrefix}-${names.dataGroup}'
  location: location
}

module admin './admin.bicep' = {
  name: '${namePrefix}-${names.adminDeployment}'
  scope: adminGroup
  params: { namePrefix: namePrefix, location: location }
}
module data './data.bicep' = {
  name: '${namePrefix}-${names.dataDeployment}'
  scope: dataGroup
  params: {
    namePrefix: namePrefix
    location: location
    portalOrigin: portalOrigin
    adminResourceGroupName: adminGroup.name
  }
  dependsOn: [admin]
}
module network './worker-network.bicep' = {
  name: '${namePrefix}-${names.networkDeployment}'
  scope: netGroup
  params: {
    namePrefix: namePrefix
    location: location
    storageId: data.outputs.storageId
    registryId: admin.outputs.registryId
  }
}
module environments './environments.bicep' = {
  name: '${namePrefix}-${names.environmentsDeployment}'
  scope: appGroup
  params: {
    namePrefix: namePrefix
    location: location
    adminResourceGroupName: adminGroup.name
    workerSubnetId: network.outputs.workerSubnetId
  }
}
output adminResourceGroupName string = adminGroup.name
output netResourceGroupName string = netGroup.name
output appResourceGroupName string = appGroup.name
output dataResourceGroupName string = dataGroup.name
output identityId string = admin.outputs.identityId
output runtimeClientId string = admin.outputs.runtimeClientId
output workerIdentityId string = admin.outputs.workerIdentityId
output workerClientId string = admin.outputs.workerClientId
output storageName string = data.outputs.storageName
output storageId string = data.outputs.storageId
output registryName string = admin.outputs.registryName
output registryServer string = admin.outputs.registryServer
output environmentId string = environments.outputs.environmentId
output workerEnvironmentId string = environments.outputs.workerEnvironmentId
output logsId string = admin.outputs.logsId
