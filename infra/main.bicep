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
param imageTag string
param tenantId string
param apiClientId string
@secure()
@minLength(1)
param entraClientSecret string
param portalOrigin string = 'https://configure-after-first-deploy.invalid'
param alertEmail string = ''

var namePrefix = '${env}-${project}'
var names = loadJsonContent('./names.json')

module foundation './foundation.bicep' = {
  name: '${namePrefix}-${names.foundationDeployment}'
  params: {
    env: env
    project: project
    location: location
    portalOrigin: portalOrigin
  }
}
module app './app.bicep' = {
  name: '${namePrefix}-${names.appDeployment}'
  scope: resourceGroup('${namePrefix}-${names.appGroup}')
  params: {
    namePrefix: namePrefix
    location: location
    imageTag: imageTag
    tenantId: tenantId
    apiClientId: apiClientId
    entraClientSecret: entraClientSecret
    identityId: foundation.outputs.identityId
    runtimeClientId: foundation.outputs.runtimeClientId
    workerIdentityId: foundation.outputs.workerIdentityId
    workerClientId: foundation.outputs.workerClientId
    registry: foundation.outputs.registryServer
    storageName: foundation.outputs.storageName
    environmentId: foundation.outputs.environmentId
    workerEnvironmentId: foundation.outputs.workerEnvironmentId
  }
}
module monitoring './monitoring.bicep' = {
  name: '${namePrefix}-${names.monitoringDeployment}'
  scope: resourceGroup('${namePrefix}-${names.adminGroup}')
  params: {
    namePrefix: namePrefix
    location: location
    alertEmail: alertEmail
    logsId: foundation.outputs.logsId
    storageId: foundation.outputs.storageId
    workerJobId: app.outputs.workerJobId
    maintenanceJobId: app.outputs.maintenanceJobId
  }
}
output portalUrl string = app.outputs.portalUrl
output registryName string = foundation.outputs.registryName
output adminResourceGroupName string = foundation.outputs.adminResourceGroupName
output netResourceGroupName string = foundation.outputs.netResourceGroupName
output appResourceGroupName string = foundation.outputs.appResourceGroupName
output dataResourceGroupName string = foundation.outputs.dataResourceGroupName
