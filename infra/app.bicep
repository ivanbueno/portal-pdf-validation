param namePrefix string
param location string = resourceGroup().location
param imageTag string
param tenantId string
param apiClientId string
@secure()
@minLength(1)
param entraClientSecret string
param identityId string
param runtimeClientId string
param workerIdentityId string
param workerClientId string
param registry string
param storageName string
param environmentId string
param workerEnvironmentId string

var names = loadJsonContent('./names.json')

var image = '${registry}/pdf-validation:${imageTag}'
var commonEnv = [
  { name: 'PDF_ENVIRONMENT', value: 'production' }
  { name: 'PDF_TENANT_ID', value: tenantId }
  { name: 'PDF_AUDIENCE', value: apiClientId }
  { name: 'PDF_AUTH_MODE', value: 'easyauth' }
  { name: 'PDF_STORAGE_ACCOUNT', value: storageName }
]
var env = concat(commonEnv, [{ name: 'AZURE_CLIENT_ID', value: runtimeClientId }])
var workerEnv = concat(commonEnv, [{ name: 'AZURE_CLIENT_ID', value: workerClientId }])
resource api 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${namePrefix}-${names.api}'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: [{ name: 'entra-client-secret', value: entraClientSecret }]
      ingress: { external: true, targetPort: 8000, transport: 'http', allowInsecure: false }
      registries: [{ server: registry, identity: identityId }]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          env: env
          resources: { cpu: json('0.5'), memory: '1Gi' }
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health/live', port: 8000 }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health/ready', port: 8000 }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '30' } } }]
      }
    }
  }
}
// Easy Auth is the only production authentication boundary. Do not expose another app port.
resource auth 'Microsoft.App/containerApps/authConfigs@2025-01-01' = {
  parent: api
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      unauthenticatedClientAction: 'Return401'
      excludedPaths: ['/', '/assets/*', '/api/config', '/health/live', '/health/ready']
    }
    httpSettings: { requireHttps: true }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: apiClientId
          clientSecretSettingName: 'entra-client-secret'
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenantId}/v2.0'
        }
        validation: { allowedAudiences: [apiClientId, 'api://${apiClientId}'] }
      }
    }
  }
}
resource worker 'Microsoft.App/jobs@2025-01-01' = {
  name: '${namePrefix}-${names.worker}'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${workerIdentityId}': {} } }
  properties: {
    environmentId: workerEnvironmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Event'
      replicaTimeout: 900
      replicaRetryLimit: 0
      registries: [{ server: registry, identity: workerIdentityId }]
      eventTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: 4
          pollingInterval: 10
          rules: [
            {
              name: 'pdf-queue'
              type: 'azure-queue'
              identity: workerIdentityId
              metadata: { accountName: storageName, queueName: 'validation', queueLength: '1' }
            }
          ]
        }
      }
    }
    template: {
      containers: [
        { name: 'worker', image: image, env: workerEnv, command: ['pdf-worker'], resources: { cpu: 2, memory: '4Gi' } }
      ]
    }
  }
}
resource maintenance 'Microsoft.App/jobs@2025-01-01' = {
  name: '${namePrefix}-${names.maintenance}'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 600
      replicaRetryLimit: 1
      registries: [{ server: registry, identity: identityId }]
      scheduleTriggerConfig: { cronExpression: '*/2 * * * *', parallelism: 1, replicaCompletionCount: 1 }
    }
    template: {
      containers: [
        {
          name: 'maintenance'
          image: image
          env: env
          command: ['pdf-maintenance']
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
    }
  }
}

output portalUrl string = 'https://${api.properties.configuration.ingress.fqdn}'
output workerJobId string = worker.id
output maintenanceJobId string = maintenance.id
