param prefix string
param location string = resourceGroup().location
param storageName string
param registryName string
param logsName string

// This VNet is dedicated to parser workers. Do not peer it with the API network
// or place other workloads in either subnet.
var workerSubnetPrefix = '10.72.0.0/24'
var privateEndpointSubnetPrefix = '10.72.1.0/27'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageName
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logsName
}

// Required workload-profiles platform dependencies, not general Internet access:
// https://learn.microsoft.com/azure/container-apps/firewall-integration
// Service tags and Azure DNS still permit platform traffic. This is not an air
// gap or an exfiltration-proof sandbox. The local ACA managed-identity endpoint
// also remains available, so the worker must have its own least-privilege identity.
var platformServiceTags = [
  'MicrosoftContainerRegistry'
  'AzureFrontDoor.FirstParty'
  'AzureActiveDirectory'
  'AzureMonitor'
]
var platformRules = [for (serviceTag, index) in platformServiceTags: {
  name: 'AllowPlatform${index}'
  properties: {
    priority: 200 + index
    direction: 'Outbound'
    access: 'Allow'
    protocol: 'Tcp'
    sourcePortRange: '*'
    destinationPortRange: '443'
    sourceAddressPrefix: workerSubnetPrefix
    destinationAddressPrefix: serviceTag
  }
}]
resource workerNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${prefix}-worker-nsg'
  location: location
  properties: {
    securityRules: concat([
      {
        name: 'AllowEnvironmentInbound'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: workerSubnetPrefix
          destinationAddressPrefix: workerSubnetPrefix
        }
      }
      {
        name: 'AllowLoadBalancerProbes'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '30000-32767'
          sourceAddressPrefix: 'AzureLoadBalancer'
          destinationAddressPrefix: workerSubnetPrefix
        }
      }
      {
        name: 'DenyOtherInbound'
        properties: {
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'AllowEnvironmentOutbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: workerSubnetPrefix
          destinationAddressPrefix: workerSubnetPrefix
        }
      }
      {
        name: 'AllowPrivateEndpointsHttps'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
          sourceAddressPrefix: workerSubnetPrefix
          destinationAddressPrefix: privateEndpointSubnetPrefix
        }
      }
      {
        name: 'AllowAzureDns'
        properties: {
          priority: 120
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '53'
          sourceAddressPrefix: workerSubnetPrefix
          destinationAddressPrefix: 'AzurePlatformDNS'
        }
      }
      {
        name: 'DenyOtherOutbound'
        properties: {
          priority: 4096
          direction: 'Outbound'
          access: 'Deny'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
        }
      }
    ], platformRules)
  }
}

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-worker-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.72.0.0/23'] }
    subnets: [
      {
        name: 'workers'
        properties: {
          addressPrefix: workerSubnetPrefix
          networkSecurityGroup: { id: workerNsg.id }
          delegations: [{ name: 'container-apps', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

// Private endpoints avoid broad Storage/AzureContainerRegistry service-tag
// exceptions. ACR's Premium SKU provides private registry AND layer endpoints.
// DNS zone groups maintain all registry data endpoint records automatically.
var privateServices = [
  { name: 'blob', resourceId: storage.id, zone: 'privatelink.blob.${environment().suffixes.storage}' }
  { name: 'queue', resourceId: storage.id, zone: 'privatelink.queue.${environment().suffixes.storage}' }
  { name: 'table', resourceId: storage.id, zone: 'privatelink.table.${environment().suffixes.storage}' }
  { name: 'registry', resourceId: registry.id, zone: 'privatelink.azurecr.io' }
]
resource privateDns 'Microsoft.Network/privateDnsZones@2020-06-01' = [for service in privateServices: {
  name: service.zone
  location: 'global'
}]
resource privateDnsLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = [for (service, index) in privateServices: {
  parent: privateDns[index]
  name: '${prefix}-worker'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: network.id }
  }
}]
resource privateEndpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [for service in privateServices: {
  name: '${prefix}-worker-${service.name}'
  location: location
  properties: {
    subnet: { id: '${network.id}/subnets/private-endpoints' }
    privateLinkServiceConnections: [
      {
        name: service.name
        properties: {
          privateLinkServiceId: service.resourceId
          groupIds: [service.name]
        }
      }
    ]
  }
}]
resource privateDnsGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (service, index) in privateServices: {
  parent: privateEndpoints[index]
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [{ name: service.name, properties: { privateDnsZoneId: privateDns[index].id } }]
  }
}]

resource workerEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${prefix}-worker-env'
  location: location
  properties: {
    vnetConfiguration: {
      internal: true
      infrastructureSubnetId: '${network.id}/subnets/workers'
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
  dependsOn: [privateDnsLinks, privateDnsGroups]
}

output environmentId string = workerEnvironment.id
output networkSecurityGroupId string = workerNsg.id
