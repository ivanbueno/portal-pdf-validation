param prefix string = 'pdfval'
param location string = resourceGroup().location
param imageTag string
param tenantId string
param apiClientId string
@secure()
@minLength(1)
param entraClientSecret string
param portalOrigin string = 'https://configure-after-first-deploy.invalid'
param alertEmail string = ''
module foundation './foundation.bicep' = {
  name: 'foundation'
  params: { prefix: prefix, location: location, portalOrigin: portalOrigin }
}
var identityId = runtime.id
var registry = foundation.outputs.registryServer
var image = '${registry}/pdf-validation:${imageTag}'
var env = [
  { name: 'PDF_ENVIRONMENT', value: 'production' }
  { name: 'PDF_TENANT_ID', value: tenantId }
  { name: 'PDF_AUDIENCE', value: apiClientId }
  { name: 'PDF_AUTH_MODE', value: 'easyauth' }
  { name: 'PDF_STORAGE_ACCOUNT', value: foundation.outputs.storageName }
  { name: 'AZURE_CLIENT_ID', value: runtime.properties.clientId }
]
resource runtime 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${prefix}-runtime'
}
resource api 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${prefix}-api'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    managedEnvironmentId: foundation.outputs.environmentId
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
      excludedPaths: ['/', '/login', '/assets/*', '/api/config', '/health/live', '/health/ready']
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
  name: '${prefix}-worker'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    environmentId: foundation.outputs.environmentId
    configuration: {
      triggerType: 'Event'
      replicaTimeout: 900
      replicaRetryLimit: 0
      registries: [{ server: registry, identity: identityId }]
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
              identity: identityId
              metadata: { accountName: foundation.outputs.storageName, queueName: 'validation', queueLength: '1' }
            }
          ]
        }
      }
    }
    template: {
      containers: [
        { name: 'worker', image: image, env: env, command: ['pdf-worker'], resources: { cpu: 2, memory: '4Gi' } }
      ]
    }
  }
}
resource maintenance 'Microsoft.App/jobs@2025-01-01' = {
  name: '${prefix}-maintenance'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    environmentId: foundation.outputs.environmentId
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
resource alerts 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${prefix}-alerts'
  location: 'global'
  properties: {
    groupShortName: 'pdfvalidate'
    enabled: true
    emailReceivers: empty(alertEmail) ? [] : [{ name: 'operator', emailAddress: alertEmail }]
  }
}
resource failureAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-processing-failures'
  location: location
  properties: {
    displayName: 'PDF processing or maintenance errors'
    skipQueryValidation: true
    enabled: true
    severity: 2
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [foundation.outputs.logsId]
    criteria: {
      allOf: [
        {
          query: 'ContainerAppConsoleLogs_CL | extend data=parse_json(Log_s) | where tostring(data.event) == "validation_infrastructure_error" or (tostring(data.event) == "maintenance_finished" and toint(data.failures) > 0)'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [alerts.id] }
  }
}
resource backlogAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-queue-backlog'
  location: 'global'
  properties: {
    description: 'Validation queue has more than 1000 messages in the hourly storage metric'
    severity: 2
    enabled: true
    scopes: ['${foundation.outputs.storageId}/queueServices/default']
    evaluationFrequency: 'PT5M'
    windowSize: 'PT1H'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'queue-depth'
          criterionType: 'StaticThresholdCriterion'
          metricName: 'QueueMessageCount'
          metricNamespace: 'Microsoft.Storage/storageAccounts/queueServices'
          operator: 'GreaterThan'
          threshold: 1000
          timeAggregation: 'Average'
        }
      ]
    }
    actions: [{ actionGroupId: alerts.id }]
  }
}
output portalUrl string = 'https://${api.properties.configuration.ingress.fqdn}'
output registryName string = foundation.outputs.registryName

resource jobFailureAlerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [
  for jobName in ['worker', 'maintenance']: {
    name: '${prefix}-${jobName}-failed'
    location: 'global'
    dependsOn: [worker, maintenance]
    properties: {
      description: 'A PDF ${jobName} job execution failed, including platform termination'
      severity: 2
      enabled: true
      scopes: [resourceId('Microsoft.App/jobs', '${prefix}-${jobName}')]
      evaluationFrequency: 'PT5M'
      windowSize: 'PT5M'
      criteria: {
        'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
        allOf: [
          {
            name: 'failed-executions'
            criterionType: 'StaticThresholdCriterion'
            metricName: 'Executions'
            metricNamespace: 'Microsoft.App/jobs'
            dimensions: [{ name: 'state', operator: 'Include', values: ['Failed'] }]
            operator: 'GreaterThan'
            threshold: 0
            timeAggregation: 'Total'
          }
        ]
      }
      actions: [{ actionGroupId: alerts.id }]
    }
  }
]
