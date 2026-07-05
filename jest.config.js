module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src/__tests__"],
  setupFiles: ["<rootDir>/jest.setup.js"]
};
