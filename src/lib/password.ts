import argon2 from 'argon2';

// OWASP-рекомендация 2024 для argon2id (Memory-hard параметры).
// memoryCost — в KiB. 19456 KiB = 19 MiB. timeCost — количество итераций.
// parallelism — количество потоков.
const HASH_OPTIONS: argon2.Options = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain, HASH_OPTIONS);

// verify возвращает false вместо throw при mismatch — это осмысленный API,
// потому что различие "неверный пароль" vs "битый хеш" наружу не нужно.
export const verifyPassword = async (hash: string, plain: string): Promise<boolean> => {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
};
