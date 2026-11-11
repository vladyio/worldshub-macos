const fs = require('fs');
const path = require('path');

const getServerPropertiesPath = (folderPath) => path.join(folderPath, 'server.properties');

function parseProperties(content) {
  const result = {};
  content.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.substring(0, idx).trim();
      const value = line.substring(idx + 1).trim();
      result[key] = value;
    }
  });
  return result;
}

function serializeProperties(obj) {
  return Object.entries(obj)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function getServerProperties(folderPath) {
  const filePath = getServerPropertiesPath(folderPath);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', 'utf-8');
    return {};
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseProperties(content);
}

function setServerProperty(folderPath, key, value) {
  const filePath = getServerPropertiesPath(folderPath);
  let props = {};
  if (fs.existsSync(filePath)) {
    props = getServerProperties(folderPath);
  }
  props[key] = value;
  fs.writeFileSync(filePath, serializeProperties(props), 'utf-8');
  return true;
}

module.exports = {
  getServerProperties,
  setServerProperty,
}; 