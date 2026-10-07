'use strict';
module.exports = Object.freeze({
  APP_NAME: 'Direct Plan Bridge', VERSION: '0.1.9',
  VENDOR: 'l89669-chatgpt-direct', AUTH_PROVIDER: 'l89669-chatgpt-direct',
  ISSUER: 'https://auth.openai.com',
  DISCOVERY_URL: 'https://auth.openai.com/.well-known/openid-configuration',
  AUTHORIZE_URL: 'https://auth.openai.com/api/accounts/authorize',
  TOKEN_URL: 'https://auth.openai.com/api/accounts/oauth/token',
  RESOURCE: 'https://api.openai.com/v1',
  MODELS_URL: 'https://api.openai.com/v1/models',
  RESPONSES_URL: 'https://api.openai.com/v1/responses',
  USAGE_URL: 'https://chatgpt.com/#settings/Usage',
  BOOTSTRAP_CLIENT: 'dynamic_agent_client', CALLBACK_PATH: '/auth/callback',
  SCOPES: Object.freeze(['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']),
  SECRET_KEY: 'direct-plan-bridge.accounts.v1', TOOL_NAMESPACE: 'vscode',
});
