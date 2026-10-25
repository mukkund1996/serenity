import { createMemoryStorage } from "../src/storage";
import { storageContract } from "../test-support";

storageContract("memory", createMemoryStorage);
