param namePrefix string
param location string = resourceGroup().location
param alertEmail string = ''
param logsId string
param storageId string
param workerJobId string
param maintenanceJobId string

var names = loadJsonContent('./names.json')

resource alerts 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${namePrefix}-${names.alerts}'
  location: 'global'
  properties: {
    groupShortName: 'pdfportal'
    enabled: true
    emailReceivers: empty(alertEmail) ? [] : [{ name: 'operator', emailAddress: alertEmail }]
  }
}
resource failureAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${namePrefix}-${names.processingAlert}'
  location: location
  properties: {
    displayName: 'PDF processing or maintenance errors'
    skipQueryValidation: true
    enabled: true
    severity: 2
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [logsId]
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
  name: '${namePrefix}-${names.backlogAlert}'
  location: 'global'
  properties: {
    description: 'Validation queue has more than 1000 messages in the hourly storage metric'
    severity: 2
    enabled: true
    scopes: ['${storageId}/queueServices/default']
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
resource jobFailureAlerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [
  for jobName in ['worker', 'maintenance']: {
    name: '${namePrefix}-${jobName == 'worker' ? names.workerFailureAlert : names.maintenanceFailureAlert}'
    location: 'global'
    properties: {
      description: 'A PDF ${jobName} job execution failed, including platform termination'
      severity: 2
      enabled: true
      scopes: [jobName == 'worker' ? workerJobId : maintenanceJobId]
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
