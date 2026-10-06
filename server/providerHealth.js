'use strict';
const {NodeOdmProvider}=require('./nodeOdmProvider');

const DIAGNOSTIC_CODES=new Set(['provider_authentication_failed','provider_credential_unavailable','provider_tls_failed','provider_unreachable','provider_busy','provider_rate_limited','provider_unavailable']);
function providerHealthDiagnosticCode(error){
  if(error?.code==='provider_busy')return error.explicitCapacityRejection===true?'provider_busy':'provider_rate_limited';
  return DIAGNOSTIC_CODES.has(error?.code)?error.code:'provider_probe_failed';
}

async function refreshOneProviderHealth({processing,providerCredentials,config={},owner,fetchImpl}){const claimed=processing.claimProviderHealth(owner);if(!claimed)return false;const {provider,credentialRevision,endpoint}=claimed;try{const credential=providerCredentials.resolveWithRevision(provider.id);if(credential.revision!==credentialRevision)throw Object.assign(new Error('provider credential changed before health check'),{code:'provider_probe_stale'});const result=await new NodeOdmProvider({endpoint,token:credential.token,providerType:provider.type,...(fetchImpl?{fetchImpl}:{}),timeoutMs:Math.min(30000,Number(config.processingProviderTimeoutMs)||30000)}).capabilities();processing.updateProviderCapabilities(provider.id,{...result,health:'healthy',expectedCredentialRevision:credentialRevision,expectedEndpoint:endpoint});processing.completeProviderHealth(provider.id,owner,{status:'healthy',expectedCredentialRevision:credentialRevision,expectedEndpoint:endpoint});}catch(error){processing.completeProviderHealth(provider.id,owner,{status:'unhealthy',errorCode:providerHealthDiagnosticCode(error),errorMessage:error.message,expectedCredentialRevision:credentialRevision,expectedEndpoint:endpoint});}return true;}

module.exports={DIAGNOSTIC_CODES,providerHealthDiagnosticCode,refreshOneProviderHealth};
