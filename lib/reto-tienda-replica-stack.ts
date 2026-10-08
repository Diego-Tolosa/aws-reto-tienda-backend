import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

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

    // ---------------------------------------------------------------------
    // Bucket Policy para permitir al servicio S3 escribir replicas
    // ---------------------------------------------------------------------
    // Sin esta policy, la Cross-Region Replication falla silenciosamente:
    // el rol de origen no puede escribir en este bucket destino.
    //
    // Se usa el principal de servicio s3.amazonaws.com (no el ARN del rol
    // especifico) para evitar una dependencia circular entre los stacks:
    // el stack de replica se despliega primero, y no puede referenciar
    // recursos que aun no existen en el stack principal.
    //
    // Las condiciones aws:SourceAccount y aws:SourceArn restringen la
    // escritura a esta cuenta y a buckets de esta cuenta unicamente.
    this.replicaBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
        actions: ['s3:ReplicateObject', 's3:ReplicateDelete', 's3:ReplicateTags'],
        resources: [`${this.replicaBucket.bucketArn}/*`],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': cdk.Aws.ACCOUNT_ID,
          },
        },
      }),
    );

    this.replicaBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
        actions: ['s3:GetBucketVersioning', 's3:PutBucketVersioning'],
        resources: [this.replicaBucket.bucketArn],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': cdk.Aws.ACCOUNT_ID,
          },
        },
      }),
    );

  }
}