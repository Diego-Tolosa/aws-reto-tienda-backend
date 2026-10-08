# Reto AWS — Backend para una Tienda Online

Almacenamiento correcto para cada tipo de dato de una tienda online, aprovisionado con AWS CDK.

## Decisión de almacenamiento por tipo de dato

Esta es la parte central del reto: cada tipo de dato tiene características distintas y el servicio elegido responde a esas características.

### Imágenes de productos → **S3** (Object Storage)

| Característica del dato | Servicio elegido | Por qué |
|---|---|---|
| Archivos grandes, no estructurados (JPG, PNG) | **S3** | Almacenamiento de objetos diseñado para archivos grandes. Escala a petabytes sin gestión manual. |
| Acceso frecuente y vía HTTP | **S3** | Sirve objetos por HTTPS nativamente. Se integra con CloudFront para distribución global. |
| Imágenes antiguas se consultan menos | **S3 con lifecycle a S3-IA** | Regla automática que mueve objetos a `STANDARD_IA` (>128 KB) a los 90 días, reduciendo costo ~40%. |

**Por qué NO EBS:** EBS es block storage, requiere una EC2 viva, no es accesible por HTTP y escala con la instancia. Sería más caro y menos flexible para imágenes.

**Por qué NO RDS/DynamoDB:** las imágenes son binarios, no datos estructurados. Meterlas en una base de datos implica bloat y problemas de rendimiento.

---

### Catálogo de productos → **RDS PostgreSQL** (Relational DB)

| Característica del dato | Servicio elegido | Por qué |
|---|---|---|
| Datos estructurados con relaciones | **RDS PostgreSQL** | Modelo relacional con `FOREIGN KEY`, `JOIN`s y transacciones ACID. |
| `products` → `categories` (muchos a uno) | **RDS** | Relación natural expresable con FK y `JOIN`. |
| `inventory` → `products` (uno a uno) | **RDS** | Tabla separada con FK, permite queries de stock sin tocar catálogo. |
| Integridad referencial (no precios negativos, no categorías huérfanas) | **RDS + CHECK + FK** | Las constraints a nivel de base de datos garantizan consistencia. |

**Esquema implementado:**

```sql
categories (category_id PK, name UNIQUE, description)
products   (product_id PK, name, description, price CHECK >= 0,
            category_id FK → categories, created_at)
inventory  (product_id PK + FK → products ON DELETE CASCADE,
            quantity CHECK >= 0, updated_at)
```

**Por qué NO DynamoDB:** DynamoDB no maneja bien las relaciones. Habría que duplicar datos (denormalizar) para cada patrón de acceso, lo que complica la consistencia cuando cambia un precio o categoría.

**Por qué NO S3:** S3 no soporta queries relacionales ni transacciones. Consultar "todos los productos de la categoría Electrónica" implicaría descargar todos los archivos.

---

### Órdenes de compra → **DynamoDB** (NoSQL)

| Característica del dato | Servicio elegido | Por qué |
|---|---|---|
| Escrituras de alta frecuencia | **DynamoDB** | Diseñado para millones de writes/segundo con latencia de un dígito en ms. |
| Acceso por `customerId` o `(customerId, orderId)` | **DynamoDB PK+SK** | El par (PK, SK) permite queries por cliente o lookup directo por orden. |
| Esquema flexible | **DynamoDB** | Cada orden puede tener atributos distintos sin migración. |
| Escalado horizontal automático | **DynamoDB PAY_PER_REQUEST** | Escala sin provisionar capacidad ni gestionar sharding. |

**Estructura:**

```
PK: customerId (S)
SK: orderId (S)
Atributos flexibles: total, status, items[], createdAt, ...
```

**Por qué NO RDS:** las órdenes no tienen relaciones complejas — son eventos inmutables que se escriben una vez y se leen por cliente u orden. RDS sería más caro y menos escalable para ese patrón.

**Por qué NO S3:** no hay queries eficientes por atributo, ni latencia baja para escrituras frecuentes.

---

### Almacenamiento temporal de procesamiento → **EBS** (Block Storage)

| Característica del dato | Servicio elegido | Por qué |
|---|---|---|
| Acceso a nivel de bloque (filesystem POSIX) | **EBS gp3** | Se monta como disco duro en la EC2. Lecturas/escrituras de baja latencia. |
| Procesamiento temporal de órdenes | **EBS gp3** | Espacio de scratch/working directory para procesos batch. |
| Necesita estar adjunto a una EC2 | **EBS** | EBS está diseñado para adjuntarse a instancias (persistencia mientras la instancia vive). |

**Por qué NO S3:** S3 es object storage — no se puede montar como filesystem (a menos que uses `s3fs`, con latencia y limitaciones). Para scratch temporal, un filesystem real es más adecuado.

**Por qué NO EFS:** EFS es más caro y está pensado para compartir entre múltiples instancias. Aquí es una sola instancia, así que EBS es suficiente.

---

## Arquitectura

```
                         us-east-1                       us-west-2
                    +------------------+           +------------------+
                    |                  |           |                  |
                    |  VPC 10.0.0.0/16 |           |                  |
                    |                  |           |                  |
                    | +--------------+ |           | +--------------+ |
                    | | PublicSubnet | |           | | Replica      | |
                    | |  EC2 t3.micro| |           | | S3 Bucket    | |
                    | |  + 20GB EBS  | |           | | (CRR destino)| |
                    | +-------+------+ |           | +------+-------+ |
                    |         |        |           |        ^         |
                    |         v        |           |        |         |
                    | +--------------+ |           |        |         |
                    | | PrivSubnet   | |           |        |         |
                    | | RDS Postgres | |           |        |         |
                    | | + ReadRep    | |           |        |         |
                    | +--------------+ |           |        |         |
                    |                  |           |        |         |
                    | +--------------+ |           |        |         |
                    | | S3 Bucket    | +-----Cross-Region Replication--+
                    | | (origen)     | |           |
                    | +--------------+ |           |
                    |                  |           |
                    | +--------------+ |           |
                    | | DynamoDB     | |           |
                    | | + Streams    | |           |
                    | +--------------+ |           |
                    +------------------+           +------------------+
```

## Servicios AWS y su rol

| Servicio | Tipo | Uso |
|---|---|---|
| **S3** | Object Storage | Imágenes de productos |
| **RDS PostgreSQL** | Relational DB | Catálogo con relaciones |
| **DynamoDB** | NoSQL | Órdenes de alta frecuencia |
| **EBS** | Block Storage | Procesamiento temporal |
| **VPC** | Red | Aislamiento de capas |
| **EC2** | Cómputo | Cliente de RDS y dueño del EBS |
| **Secrets Manager** | Secretos | Contraseña de RDS |
| **DynamoDB Streams** | CDC | Eventos de órdenes en tiempo real (Boss Fight) |
| **RDS Read Replica** | Réplica | Distribución de lecturas (Boss Fight) |
| **S3 CRR** | Replicación | Disponibilidad global (Boss Fight) |

## Estructura del proyecto

```
reto-tienda-backend/
├── bin/
│   └── reto-tienda-backend.ts         # App CDK con 2 stacks
├── lib/
│   ├── reto-tienda-backend-stack.ts   # Stack principal (us-east-1)
│   └── reto-tienda-replica-stack.ts   # Stack de réplica (us-west-2)
├── test/
├── cdk.json
├── cdk.context.json
├── package.json
└── tsconfig.json
```

## Requisitos previos

- Node.js 18+
- AWS CLI con perfil que pueda asumir roles de bootstrap
- Cuenta AWS bootstrappeada en **ambas regiones** (`us-east-1` y `us-west-2`)

En este proyecto:
- Cuenta: `299014720567`
- Regiones: `us-east-1` (principal) y `us-west-2` (réplica)
- Perfil CLI: `cdk-developer`

## Comandos

```bash
npm install
npx tsc

AWS_PROFILE=cdk-developer cdk synth
AWS_PROFILE=cdk-developer cdk diff --all
AWS_PROFILE=cdk-developer cdk deploy --all
AWS_PROFILE=cdk-developer cdk destroy --all
```

**Nota:** `--all` es necesario porque hay 2 stacks. Sin él, CDK pide elegir uno.

## Detalles de implementación

### VPC

- CIDR `10.0.0.0/16` (requisito del reto).
- 2 AZs (`us-east-1a` y `us-east-1b`).
- 2 subnets públicas (`10.0.0.0/24`, `10.0.1.0/24`) para la EC2.
- 2 subnets **privadas aisladas** (`10.0.2.0/24`, `10.0.3.0/24`) para RDS.
- `natGateways: 0` — las subnets privadas son `PRIVATE_ISOLATED`, sin salida a internet. Ahorra ~$64/mes.

### Security Groups

- **`ec2-sg`**: sin ingress. La EC2 solo se administra por SSM.
- **`rds-sg`**: ingress TCP 5432 **solo desde `ec2-sg`**. Cero reglas con `0.0.0.0/0`.

### S3 — `ProductImagesBucket`

- `BlockPublicAccess.BLOCK_ALL`.
- **Versionado habilitado** (requisito de CRR).
- **Lifecycle rule**: transición a `STANDARD_IA` a los 90 días.
- **Replication rule** hacia el bucket de `us-west-2`.
- `removalPolicy: DESTROY` + `autoDeleteObjects: true`.

### DynamoDB — `OrdersTable`

- PK: `customerId` (S).
- SK: `orderId` (S).
- `billingMode: PAY_PER_REQUEST`.
- **Streams** habilitado con `NEW_AND_OLD_IMAGES` (Boss Fight).

### RDS — `CatalogDatabase` + `CatalogReadReplica`

- Engine PostgreSQL 16.3.
- `db.t3.micro` Single-AZ.
- Subnets `PRIVATE_ISOLATED` + `publiclyAccessible: false`.
- Credenciales generadas y guardadas en **Secrets Manager**.
- Storage gp3 de 20 GB **cifrado en reposo**.
- `backupRetention: 1 día` (requisito para permitir Read Replica).
- Read Replica en la misma VPC, mismo SG.

### EC2 + EBS — `ProcessingInstance`

- `t3.micro` en subnet pública con `AmazonSSMManagedInstanceCore`.
- Volumen raíz 8 GB gp3 + volumen de datos 20 GB gp3.
- `deleteOnTermination: true` en ambos.
- IAM Role con permiso `secretsmanager:GetSecretValue` **solo sobre el secret de RDS**.

### Cross-Region Replication

- **Stack secundario** `RetoTiendaReplicaStack` en `us-west-2`.
- Bucket réplica con versionado + `autoDeleteObjects`.
- `crossRegionReferences: true` en ambos stacks.
- `ReplicationRole` con permisos mínimos:
  - `s3:GetObjectVersionForReplication`, `s3:GetObjectVersionAcl`, `s3:GetObjectVersionTagging` sobre el origen.
  - `s3:ReplicateObject`, `s3:ReplicateDelete`, `s3:ReplicateTags` sobre el destino.
- Bucket Policy en el destino con principal `s3.amazonaws.com` y condición `aws:SourceAccount`.

**Importante:** cuando se pasa un `replicationRole` explícito a `s3.Bucket`, CDK **NO** le agrega las policies automáticamente. Hay que agregarlas a mano.

## Pruebas realizadas

### Verificación de los 4 tipos de almacenamiento

```bash
# S3 lifecycle
aws s3api get-bucket-lifecycle-configuration --bucket retotienda...-productimages...
# → StandardIA, 90 días, Enabled ✅

# RDS no accesible públicamente
# Consola RDS → Publicly accessible: No ✅

# DynamoDB escritura con estructura PK/SK
aws dynamodb put-item --table-name RetoTiendaBackendStack-OrdersTable... --item '{...}'
aws dynamodb get-item --key '{customerId, orderId}'
# → Item recuperado con todos los atributos ✅

# EBS adjunto
# Consola EC2 → 2 volúmenes gp3 adjuntos ✅
```

### Tablas RDS creadas vía SSM

Desde Session Manager en `ProcessingInstance`:

```sql
CREATE TABLE categories (...);
CREATE TABLE products (...);
CREATE TABLE inventory (...);
CREATE INDEX idx_products_category ON products(category_id);
```

Esquema verificado con `\d products` y `\d inventory`: FK, CHECK y CASCADE correctos.

### Boss Fight verificado

**DynamoDB Streams:**
```
Stream status: Activado
View type: Imágenes nuevas y viejas
```

**RDS Read Replica:**
```
Principal: retotiendabackendstack-catalogdatabasea264b8d1-vcing6wlia2m
Réplica:   retotiendabackendstack-catalogreadreplica832f8a4c-s71lbfosc9fi
```
Prueba: `INSERT INTO categories (...) VALUES ('Electronica', ...)` en la primaria → la fila apareció inmediatamente en la réplica.

**S3 Cross-Region Replication:**
```bash
aws s3 cp test.bin s3://reto...productimages.../test/ --region us-east-1
aws s3api list-objects-v2 --bucket reto...replicaimages... --region us-west-2
# → test/replication-test-2.bin (204800 bytes) ✅
```

## Cleanup

```bash
AWS_PROFILE=cdk-developer cdk destroy --all
```

**Advertencias:**
- **RDS Read Replica debe eliminarse antes que la primaria.** CDK lo maneja automáticamente por dependencias, pero el destroy puede tardar 10-15 min.
- **La primaria tarda ~7-10 min en eliminar** (backup final, snapshot final, etc.).
- **Los buckets S3 con `autoDeleteObjects: true`** se vacían automáticamente antes de eliminarse.
- **Los stacks se destruyen en orden inverso a la dependencia:** primero el principal (us-east-1), luego el de réplica (us-west-2).

Verificar huérfanos:
- **RDS → Databases** → ninguna instancia del stack.
- **S3 → Buckets** → ningún bucket del stack.
- **EC2 → Volumes** → ningún volumen disponible.
- **DynamoDB → Tables** → ninguna tabla.

## Notas

- `catalog` es **palabra reservada** en PostgreSQL. El nombre de la base de datos es `tienda`.
- Cuando se pasa un `replicationRole` explícito a `s3.Bucket`, CDK **no** agrega las policies automáticamente. Hay que agregarlas a mano.
- La CRR **no hace backfill** de objetos que fallaron antes de que la configuración de permisos fuera correcta. Solo replica objetos nuevos.
- `PRIVATE_ISOLATED` evita el costo del NAT Gateway (~$32/mes por AZ).
- El bootstrap de CDK debe ejecutarse en **cada región** donde se despliegan stacks (`us-east-1` y `us-west-2`).
