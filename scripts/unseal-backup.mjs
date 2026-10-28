import { resolve } from 'node:path';
import { decryptBackupFile, readBackupKey } from '../backup-encryption.mjs';
import './env.mjs';

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) throw new Error('用法：npm run backup:unseal -- <加密文件路径> <解密 tar.gz 路径>');
const keyFile = process.env.BACKUP_KEY_FILE || '';
if (!keyFile) throw new Error('请通过 BACKUP_KEY_FILE 指定 32 字节密钥文件。');
const key = await readBackupKey(keyFile);
const output = await decryptBackupFile(resolve(inputArg), resolve(outputArg), key);
console.log(`备份认证通过并解密完成：${output}`);
