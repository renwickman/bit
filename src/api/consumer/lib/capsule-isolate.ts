import _ from 'lodash';
import os from 'os';
import * as path from 'path';
import hash from 'object-hash';
import v4 from 'uuid';
import { ComponentWithDependencies } from '../../../scope';
import { loadConsumer } from '../../../consumer';
import Isolator from '../../../environment/isolator';
import capsuleOrchestrator from '../../../orchestrator/orchestrator';
import { BitId } from '../../../bit-id';
import loadFlattenedDependenciesForCapsule from '../../../consumer/component-ops/load-flattened-dependencies';
import BitCapsule from '../../../capsule/bit-capsule';
import Consumer from '../../../consumer/consumer';
import { getComponentLinks } from '../../../links/link-generator';
import Component from '../../../consumer/component';
import DataToPersist from '../../../consumer/component/sources/data-to-persist';

const DEFAULT_ISOLATION_OPTIONS = {
  override: false,
  writePackageJson: true,
  writeConfig: false,
  writeBitDependencies: true,
  createNpmLinkFiles: false,
  saveDependenciesAsComponents: false,
  writeDists: true,
  installNpmPackages: true,
  installPeerDependencies: false,
  verbose: true,
  excludeRegistryPrefix: true,
  silentPackageManagerResult: false,
  shouldBuildDependencies: false,
  keepExistingCapsule: true,
  baseDir: os.tmpdir()
};
const DEFAULT_GLOBAL_OPTIONS = {
  new: false,
  installPackages: false
};
export type CapsuleOptions = {
  baseDir?: string;
  // wrkDir?: string;
  writeDists?: boolean;
  installNpmPackages?: boolean;
  installPeerDependencies?: boolean;
  verbose?: boolean;
  silentPackageManagerResult?: boolean;
};

type GlobalCapsuleOptions = {
  new?: boolean;
  hash?: string;
  installPackages?: boolean;
};

function generateWrkDir(
  bitId: string,
  globalHash: string,
  capsuleOptions: CapsuleOptions,
  globalCapsuleOptions: GlobalCapsuleOptions
) {
  if (globalCapsuleOptions.new) return path.join(capsuleOptions.baseDir!, `${bitId}_${globalHash}`);
  if (globalCapsuleOptions.hash) return path.join(capsuleOptions.baseDir!, `${bitId}_${globalCapsuleOptions.hash}`);
  return path.join(capsuleOptions.baseDir!, `${bitId}_${hash(capsuleOptions)}`);
}
async function createOrGetCapsules(
  components: Component[],
  capsuleOptions: CapsuleOptions = DEFAULT_ISOLATION_OPTIONS,
  globalCapsuleOptions: GlobalCapsuleOptions,
  consumer: Consumer
): Promise<{ capsuleMap: { [bitId: string]: string }; capsules: BitCapsule[] }> {
  const capsuleMap = {};
  const globalHash = v4();

  const idsForIsolation: Component[] = _.map(components, component => {
    const componentFromBitMap = consumer.bitMap.getBitIdIfExist(component.id, { ignoreVersion: true });
    if (componentFromBitMap) {
      const wrkDir = generateWrkDir(component.id.toString(), globalHash, capsuleOptions, globalCapsuleOptions);
      return {
        resourceId: `${componentFromBitMap.toString()}_${hash(wrkDir)}`,
        options: {
          bitId: component.id,
          wrkDir,
          capsuleOptions
        }
      };
    }
  });

  const resources = await capsuleOrchestrator.getCapsules(consumer.getPath(), _.compact(idsForIsolation));
  const capsules = resources.map(resource => {
    const capsule = resource.use() as BitCapsule;
    capsuleMap[capsule.bitId.toString()] = capsule.wrkDir;
    return capsule;
  });
  return {
    capsuleMap,
    capsules
  };
}

async function writeLinkFiles(consumer, isolator: Isolator) {
  const componentWithDependencies = await _loadComponentFromConsumer(consumer, isolator.capsule.bitId);
  componentWithDependencies.component.writtenPath = '.';
  const componentLinkFiles: DataToPersist = getComponentLinks({
    consumer,
    component: componentWithDependencies.component,
    dependencies: componentWithDependencies.allDependencies,
    bitMap: consumer.bitMap,
    createNpmLinkFiles: true
  });
  await Promise.all(componentLinkFiles.files.map(file => isolator.capsule.outputFile(file.path, file.contents, {})));
}

async function installpackages(capsules: BitCapsule[]) {
  return Promise.all(capsules.map(capsule => capsule.exec({ command: `npm i`.split(' ') })));
}

async function isolateCapsules(
  consumer: Consumer,
  capsuleOptions: CapsuleOptions,
  capsules: BitCapsule[],
  capsuleMap: { [bitId: string]: string }
) {
  await Promise.all(
    _.map(capsules, async capsule => {
      const isolator: Isolator = await Isolator.getInstance(
        'fs',
        consumer.scope,
        consumer,
        capsule.wrkDir,
        capsule,
        capsuleMap
      );
      await isolator.isolate(
        capsule.bitId,
        _.assign(
          DEFAULT_ISOLATION_OPTIONS,
          {
            writeToPath: capsule.wrkDir
          },
          capsuleOptions
        )
      );
      return writeLinkFiles(consumer, isolator);
    })
  );
}

async function _loadComponentFromConsumer(consumer: Consumer, id: BitId): Promise<ComponentWithDependencies> {
  if (!consumer) throw new Error('missing consumer');
  const component = await consumer.loadComponentForCapsule(id);
  return loadFlattenedDependenciesForCapsule(consumer, component);
}

export default (async function capsuleIsolate(
  bitIds: BitId[] | string[],
  capsuleOptions: CapsuleOptions,
  globalCapsuleOptions: GlobalCapsuleOptions = DEFAULT_GLOBAL_OPTIONS
): Promise<any> {
  if (!capsuleOrchestrator.loaded) await capsuleOrchestrator.buildPools();
  const consumer = await loadConsumer();
  const capsuleObj: { [bitId: string]: BitCapsule } = {};
  const allComponents: Component[] = await Promise.all(
    _.map(bitIds, async function(bitId) {
      const bitID = bitId instanceof BitId ? bitId : consumer.getParsedId(bitId);
      const component = await _loadComponentFromConsumer(consumer, bitID);
      return _.concat(component.component, component.allDependencies);
    })
  );
  const uniqComponents: Component[] = _.uniq(_.flatten(allComponents), (component: Component) =>
    component.id.toString()
  );
  const {
    capsuleMap,
    capsules
  }: { capsuleMap: { [bitId: string]: string }; capsules: BitCapsule[] } = await createOrGetCapsules(
    uniqComponents,
    _.assign(DEFAULT_ISOLATION_OPTIONS, capsuleOptions),
    _.assign(DEFAULT_GLOBAL_OPTIONS, globalCapsuleOptions),
    consumer
  );
  await isolateCapsules(consumer, capsuleOptions, capsules, capsuleMap);
  if (globalCapsuleOptions.installPackages) await installpackages(capsules);
  _.map(capsules, (capsule: BitCapsule) => (capsuleObj[capsule.bitId.toString()] = capsule));
  return capsuleObj;
});
