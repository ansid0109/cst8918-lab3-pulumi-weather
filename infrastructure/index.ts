import * as pulumi from '@pulumi/pulumi';
import * as cache from '@pulumi/azure-native/redis';
import * as resources from '@pulumi/azure-native/resources';
import * as containerregistry from '@pulumi/azure-native/containerregistry';
import * as dockerBuild from '@pulumi/docker-build';
import * as containerinstance from '@pulumi/azure-native/containerinstance';

// ==========================================
// 1. Load Configuration Settings
// ==========================================
const config = new pulumi.Config();
const appPath = config.require('appPath');
const prefixName = config.require('prefixName');
const imageName = prefixName;
const imageTag = config.require('imageTag');

const containerPort = config.requireNumber('containerPort');
const publicPort = config.requireNumber('publicPort');
const cpu = config.requireNumber('cpu');
const memory = config.requireNumber('memory');

// ==========================================
// 2. Define Azure Resource Group & ACR
// ==========================================
// Create a resource group (Hyphens are allowed here)
const resourceGroup = new resources.ResourceGroup(`${prefixName}-rg`);

const redis = new cache.Redis(`${prefixName}-redis`, {
  name: `${prefixName}-weather-cache`,
  location: 'westus3',
  resourceGroupName: resourceGroup.name,
  enableNonSslPort: true,
  redisVersion: 'Latest',
  minimumTlsVersion: '1.2',
  redisConfiguration: {
    maxmemoryPolicy: 'allkeys-lru',
  },
  sku: {
    name: 'Basic',
    family: 'C',
    capacity: 0,
  },
});

const redisAccessKey = cache
  .listRedisKeysOutput({
    name: redis.name,
    resourceGroupName: resourceGroup.name,
  })
  .apply((keys) => keys.primaryKey);

const redisConnectionString = pulumi.interpolate`rediss://:${redisAccessKey}@${redis.hostName}:${redis.sslPort}`;

// Clean the prefix name by removing all hyphens so Azure accepts it for the ACR
const cleanAcrName = prefixName.replace(/-/g, '');

// Create the container registry (Basic tier for cost optimization)
const registry = new containerregistry.Registry(`${cleanAcrName}ACR`, {
  resourceGroupName: resourceGroup.name,
  adminUserEnabled: true,
  sku: {
    name: containerregistry.SkuName.Basic,
  },
});

// Fetch administrative credentials for the container registry
const registryCredentials = containerregistry
  .listRegistryCredentialsOutput({
    resourceGroupName: resourceGroup.name,
    registryName: registry.name,
  })
  .apply((creds) => {
    return {
      username: creds.username!,
      password: creds.passwords![0].value!,
    };
  });

// ==========================================
// 3. Build Docker Image & Push to ACR
// ==========================================
const image = new dockerBuild.Image(`${prefixName}-image`, {
  tags: [pulumi.interpolate`${registry.loginServer}/${imageName}:${imageTag}`],
  context: { location: appPath },
  dockerfile: { location: `${appPath}/Dockerfile` },
  // target: 'production',  // <-- This line is now commented out!
  platforms: ['linux/amd64'],
  push: true,
  registries: [
    {
      address: registry.loginServer,
      username: registryCredentials.username,
      password: registryCredentials.password,
    },
  ],
});

// ==========================================
// 4. Deploy to Azure Container Instances (ACI)
// ==========================================
const containerGroup = new containerinstance.ContainerGroup(
  `${prefixName}-container-group`,
  {
    resourceGroupName: resourceGroup.name,
    osType: 'linux',
    restartPolicy: 'always',
    imageRegistryCredentials: [
      {
        server: registry.loginServer,
        username: registryCredentials.username,
        password: registryCredentials.password,
      },
    ],
    containers: [
      {
        name: imageName,
        image: image.ref,
        ports: [
          {
            port: containerPort,
            protocol: 'tcp',
          },
        ],
        environmentVariables: [
          {
            name: 'PORT',
            value: containerPort.toString(),
          },
          {
            name: 'WEATHER_API_KEY',
            value: config.requireSecret('weatherApiKey')
          },
          {
            name: 'REDIS_URL',
            value: redisConnectionString,
          },
        ],
        resources: {
          requests: {
            cpu: cpu,
            memoryInGB: memory,
          },
        },
      },
    ],
    ipAddress: {
      type: containerinstance.ContainerGroupIpAddressType.Public,
      dnsNameLabel: `${imageName}`,
      ports: [
        {
          port: publicPort,
          protocol: 'tcp',
        },
      ],
    },
  }
);

// ==========================================
// 5. Infrastructure Outputs
// ==========================================
export const hostname = containerGroup.ipAddress.apply((addr) => addr!.fqdn!);
export const ip = containerGroup.ipAddress.apply((addr) => addr!.ip!);
export const url = containerGroup.ipAddress.apply(
  (addr) => `http://${addr!.fqdn!}:${containerPort}`
);
