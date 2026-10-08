#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RetoTiendaBackendStack } from '../lib/reto-tienda-backend-stack';
import { RetoTiendaReplicaStack } from '../lib/reto-tienda-replica-stack';

const app = new cdk.App();

// -------------------------------------------------------------------------
// Stack secundario en us-west-2: bucket de replicacion cross-region
// -------------------------------------------------------------------------
// Se despliega primero porque el stack principal depende de su bucket.
const replicaStack = new RetoTiendaReplicaStack(
  app,
  'RetoTiendaReplicaStack',
  {
    env: {
      account: '299014720567',
      region: 'us-west-2',
    },
    crossRegionReferences: true,
  },
);

// -------------------------------------------------------------------------
// Stack principal en us-east-1
// -------------------------------------------------------------------------
// Recibe el bucket de replica para configurar la replication rule.
new RetoTiendaBackendStack(app, 'RetoTiendaBackendStack', {
  env: {
    account: '299014720567',
    region: 'us-east-1',
  },
  crossRegionReferences: true,
  replicaBucket: replicaStack.replicaBucket,
});
