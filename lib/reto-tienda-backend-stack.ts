import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as rds from 'aws-cdk-lib/aws-rds';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class RetoTiendaBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // VPC
    // ---------------------------------------------------------------------
    // CIDR /16 segun requisito del reto.
    // 2 AZs para que RDS pueda crear su DB Subnet Group (requiere >= 2 AZs).
    // 2 subnets publicas para la EC2 de procesamiento (con SSM).
    // 2 subnets privadas aisladas para RDS (sin NAT, sin salida a internet).
    const vpc = new ec2.Vpc(this, 'TiendaVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // ---------------------------------------------------------------------
    // Security Group para la instancia EC2 de procesamiento
    // ---------------------------------------------------------------------
    // Sin ingress: la EC2 se administra exclusivamente por SSM.
    // Egress abierto para que pueda hablarle a RDS y a Secrets Manager.
    const ec2Sg = new ec2.SecurityGroup(this, 'Ec2Sg', {
      vpc,
      description: 'EC2 de procesamiento: acceso solo por SSM',
      allowAllOutbound: true,
    });

    // ---------------------------------------------------------------------
    // Security Group para RDS
    // ---------------------------------------------------------------------
    // Solo acepta PostgreSQL (5432) desde la EC2 de procesamiento.
    // Ninguna regla con 0.0.0.0/0.
    const rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc,
      description: 'RDS: solo PostgreSQL desde la capa EC2',
      allowAllOutbound: true,
    });

    rdsSg.addIngressRule(
      ec2Sg,
      ec2.Port.tcp(5432),
      'PostgreSQL solo desde la EC2 de procesamiento',
    );

    // ---------------------------------------------------------------------
    // Bucket S3 para imagenes de productos
    // ---------------------------------------------------------------------
    // Object Storage para archivos no estructurados (imagenes JPG, PNG, etc).
    // Elegido sobre EBS (block) porque S3 escala a petabytes sin gestion
    // manual, sirve objetos por HTTP y su costo por GB es mucho menor.
    const imagesBucket = new s3.Bucket(this, 'ProductImagesBucket', {
      // Bloquea cualquier acceso publico. Las imagenes se serviran por
      // URL firmada o CloudFront, no por acceso directo.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,

      // Versionado habilitado: requisito para Cross-Region Replication
      // (Boss Fight) y proteccion contra borrados accidentales.
      versioned: true,

      // Lifecycle: mueve a S3-IA a los 90 dias para reducir costo.
      // Requisito explicito del reto.
      lifecycleRules: [
        {
          id: 'Mover-a-IA-a-los-90-dias',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],

      // Cleanup limpio con cdk destroy.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

        // ---------------------------------------------------------------------
    // Tabla DynamoDB para ordenes de compra
    // ---------------------------------------------------------------------
    // NoSQL para escrituras de alta frecuencia con esquema flexible.
    // Elegido sobre RDS porque las ordenes no tienen relaciones complejas:
    // son eventos inmutables que se escriben una vez y se leen por cliente
    // u orden. DynamoDB escala horizontalmente sin gestion de capacidad.
    //
    // PK customerId + SK orderId: patron tipico de acceso.
    // - Query por customerId -> todas las ordenes de un cliente.
    // - Get por (customerId, orderId) -> una orden especifica.
    const ordersTable = new dynamodb.Table(this, 'OrdersTable', {
      partitionKey: {
        name: 'customerId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'orderId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

        // ---------------------------------------------------------------------
    // RDS PostgreSQL para el catalogo de productos
    // ---------------------------------------------------------------------
    // RDS elegido sobre DynamoDB porque el catalogo tiene RELACIONES:
    // products -> categories (muchos a uno)
    // products <-> inventory (uno a uno)
    // SQL maneja estas relaciones con JOINs, FOREIGN KEYs y transacciones.
    // DynamoDB no esta disenado para este patron y lo forzaria a duplicar datos.
    //
    // Ubicado en subnets PRIVATE_ISOLATED: sin IP publica, sin ruta a internet.
    // Solo la EC2 de procesamiento puede hablarle (via rds-sg).
    const database = new rds.DatabaseInstance(this, 'CatalogDatabase', {
      // PostgreSQL: open source, sin licencias, robusto para datos relacionales.
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_3,
      }),

      // Instancia mas barata que cumple el reto.
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),

      // Subnets privadas aisladas: sin acceso desde internet.
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },

      // Doble garantia: RDS explicitamente no publico.
      publiclyAccessible: false,

      // Solo acepta trafico desde la EC2 de procesamiento (rds-sg).
      securityGroups: [rdsSg],

      // Contrasena generada aleatoriamente y guardada en Secrets Manager.
      // No hardcodeada, no versionada en Git.
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),

      // Nombre de la base de datos inicial.
      databaseName: 'catalog',

      // Storage: gp3 de 20 GB (minimo para gp3).
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
       // Cifrado en reposo con la key gestionada por RDS.
      // Sin costo extra y elimina el warning de seguridad de AWS.
      storageEncrypted: true,

      // Sin backups automaticos para laboratorio (ahorra costo).
      backupRetention: cdk.Duration.days(0),

      // Si algun dia se habilitan backups, se borran al destruir.
      deleteAutomatedBackups: true,

      // Cleanup limpio.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
