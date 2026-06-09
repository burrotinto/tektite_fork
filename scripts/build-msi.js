const fs = require("node:fs");
const path = require("node:path");
const { MSICreator } = require("electron-wix-msi");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));

// Fester Upgrade-Code, damit künftige Versionen die installierte App in place
// aktualisieren statt parallel zu installieren. NICHT ändern.
const UPGRADE_CODE = "3f1a7c2e-9b4d-4e6a-8c1f-2d5b7e9a0c11";

async function main() {
  const appDirectory = path.join(root, "Tektite-win32-x64");
  if (!fs.existsSync(appDirectory)) {
    throw new Error(`Packaged app not found at ${appDirectory}. Run "npm run package:win" first.`);
  }

  const outputDirectory = path.join(root, "dist");
  fs.mkdirSync(outputDirectory, { recursive: true });

  const iconPath = path.join(root, "assets", "icons", "tektite-icon.ico");

  const creator = new MSICreator({
    appDirectory,
    outputDirectory,
    exe: "Tektite",
    name: "Tektite",
    manufacturer: "Mathias Conradt",
    description: pkg.description,
    version: pkg.version,
    icon: iconPath,
    upgradeCode: UPGRADE_CODE,
    arch: "x64",
    defaultInstallMode: "perUser",
    ui: { chooseDirectory: true }
  });

  await creator.create();
  const { msiFile } = await creator.compile();

  const versioned = path.join(outputDirectory, `Tektite-${pkg.version}-x64.msi`);
  fs.renameSync(msiFile, versioned);
  console.log(`Created ${versioned}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
