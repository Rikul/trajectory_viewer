// The tests are TypeScript run directly by Node, which needs built-in type stripping (Node >= 22.18).
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`npm test needs Node >= 22.18 (it runs the .ts tests directly); this is Node ${process.versions.node}.`);
  process.exit(1);
}
