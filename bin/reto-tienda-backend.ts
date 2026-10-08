#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { RetoTiendaBackendStack } from '../lib/reto-tienda-backend-stack';

const app = new cdk.App();
new RetoTiendaBackendStack(app, 'RetoTiendaBackendStack', {
  env: {
    account: '299014720567',
    region: 'us-east-1',
  },
});
