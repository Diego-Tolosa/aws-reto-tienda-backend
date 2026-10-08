import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Stack secundario en us-west-2.
 *
 * Contiene el bucket que recibe la replicacion cross-region desde el
 * bucket principal en us-east-1 (Boss Fight: disponibilidad global).
 *
 * Vive en su propio stack porque un stack CDK pertenece a UNA sola region.
 */
export class RetoTiendaReplicaStack extends cdk.Stack {
  /** Bucket de replicacion, expuesto para que el stack principal lo referencie. */
  public readonly replicaBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // Bucket S3 de replicacion (us-west-2)
    // ---------------------------------------------------------------------
    // Recibe copias de los objetos del bucket principal via CRR.
    // Versionado obligatorio (requisito de CRR).
    // BlockPublicAccess por consistencia y seguridad.
    // removalPolicy DESTROY para cleanup limpio con cdk destroy.
    this.replicaBucket = new s3.Bucket(this, 'ReplicaImagesBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }
}