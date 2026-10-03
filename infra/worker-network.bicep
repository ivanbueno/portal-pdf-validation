param namePrefix string
param location string = resourceGroup().location
param storageId string
param registryId string

var names = loadJsonContent('./names.json')

// This VNet is dedicated to parser workers. Do not peer it with the API network
// or place other workloads in either subnet.
var workerSubnetPrefix = '10.72.0.0/24'
var privateEndpointSubnetPrefix = '10.72.1.0/27'

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
  name: '${namePrefix}-${names.workerNsg}'
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
  name: '${namePrefix}-${names.workerVnet}'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.72.0.0/23'] }
    subnets: [
      {
        name: '${namePrefix}-${names.workerSubnet}'
        properties: {
          addressPrefix: workerSubnetPrefix
          networkSecurityGroup: { id: workerNsg.id }
          delegations: [{ name: 'container-apps', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: '${namePrefix}-${names.privateEndpointSubnet}'
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
  { name: 'blob', endpointName: '${namePrefix}-${names.blobEndpoint}', dnsLinkName: '${namePrefix}-${names.blobDnsLink}', resourceId: storageId, zone: 'privatelink.blob.${environment().suffixes.storage}' }
  { name: 'queue', endpointName: '${namePrefix}-${names.queueEndpoint}', dnsLinkName: '${namePrefix}-${names.queueDnsLink}', resourceId: storageId, zone: 'privatelink.queue.${environment().suffixes.storage}' }
  { name: 'table', endpointName: '${namePrefix}-${names.tableEndpoint}', dnsLinkName: '${namePrefix}-${names.tableDnsLink}', resourceId: storageId, zone: 'privatelink.table.${environment().suffixes.storage}' }
  { name: 'registry', endpointName: '${namePrefix}-${names.registryEndpoint}', dnsLinkName: '${namePrefix}-${names.registryDnsLink}', resourceId: registryId, zone: 'privatelink.azurecr.io' }
]
resource privateDns 'Microsoft.Network/privateDnsZones@2020-06-01' = [for service in privateServices: {
  name: service.zone
  location: 'global'
}]
resource privateDnsLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = [for (service, index) in privateServices: {
  parent: privateDns[index]
  name: service.dnsLinkName
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: network.id }
  }
}]
resource privateEndpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [for service in privateServices: {
  name: service.endpointName
  location: location
  properties: {
    subnet: { id: '${network.id}/subnets/${namePrefix}-${names.privateEndpointSubnet}' }
    privateLinkServiceConnections: [
      {
        name: service.endpointName
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

output workerSubnetId string = '${network.id}/subnets/${namePrefix}-${names.workerSubnet}'
output networkSecurityGroupId string = workerNsg.id
