param namePrefix string
param location string = resourceGroup().location
param adminResourceGroupName string
param workerSubnetId string

var names = loadJsonContent('./names.json')

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  scope: resourceGroup(adminResourceGroupName)
  name: '${namePrefix}-${names.logs}'
}
resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${namePrefix}-${names.environment}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}
resource workerEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${namePrefix}-${names.workerEnvironment}'
  location: location
  properties: {
    vnetConfiguration: {
      internal: true
      infrastructureSubnetId: workerSubnetId
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}

output environmentId string = environment.id
output workerEnvironmentId string = workerEnvironment.id
