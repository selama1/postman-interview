import { describe, expect, it } from 'vitest';
import { parseFields, parseTableName, singular, snake, splitTop, SpecError } from './spec.js';

const EXAMPLE =
  'isbn:text:unique, status:enum(draft|in_review|published|out_of_print), priceUsd:numeric(10,2), pageCount:int?:min0, authorId:ref(authors), publishedAt:timestamptz?';

describe('gen:resource field spec parser', () => {
  it('parses the documented example: types, nullability, modifiers, snake_case columns', () => {
    const f = parseFields(EXAMPLE);
    expect(f.map((x) => [x.name, x.column, x.kind, x.nullable])).toEqual([
      ['isbn', 'isbn', 'text', false],
      ['status', 'status', 'enum', false],
      ['priceUsd', 'price_usd', 'numeric', false],
      ['pageCount', 'page_count', 'int', true],
      ['authorId', 'author_id', 'ref', false],
      ['publishedAt', 'published_at', 'timestamptz', true],
    ]);
    expect(f[0]).toMatchObject({ unique: true, max: 200 });
    expect(f[1]!.values).toEqual(['draft', 'in_review', 'published', 'out_of_print']);
    expect(f[2]).toMatchObject({ precision: 10, scale: 2 });
    expect(f[3]).toMatchObject({ min0: true, positive: false });
    expect(f[4]!.refTable).toBe('authors');
  });

  it('does not split on the comma inside numeric(p,s), and tolerates spaces', () => {
    expect(splitTop('a:numeric(10,2), b:int')).toEqual(['a:numeric(10,2)', 'b:int']);
    expect(parseFields('w:numeric( 8 , 3 )')[0]).toMatchObject({ precision: 8, scale: 3 });
  });

  it('text max defaults to 200 and max=<n> overrides it', () => {
    const [a, b] = parseFields('a:text, b:text:max=12');
    expect([a!.max, b!.max]).toEqual([200, 12]);
  });

  describe('every bad spec throws a SpecError naming the token, the valid options and an example', () => {
    const cases: Array<[spec: string, token: string, why: RegExp]> = [
      ['price:float', 'price:float', /unknown type "float"/],
      ['a:text:wibble', 'a:text:wibble', /unknown modifier "wibble"/],
      ['a:int:max=5', 'a:int:max=5', /text only/],
      ['a:text:min0', 'a:text:min0', /int, bigint and numeric only/],
      ['a:int:min0:positive', 'a:int:min0:positive', /either min0 or positive/],
      ['a:enum(x|y):unique', 'a:enum(x|y):unique', /unique/],
      ['a:bool:unique', 'a:bool:unique', /unique/],
      ['a:enum(x)', 'a:enum(x)', /at least two values/],
      ['a:enum(x|x)', 'a:enum(x|x)', /distinct/],
      ['a:enum(x|y-z)', 'a:enum(x|y-z)', /letters, digits/],
      ['a:numeric(4,4)', 'a:numeric(4,4)', /scale < precision|scale must|scale < p/],
      ['id:int', 'id:int', /reserved/],
      ['createdAt:date', 'createdAt:date', /reserved/],
      ['Price_Usd:int', 'Price_Usd:int', /camelCase/],
      ['author:ref(authors)', 'author:ref(authors)', /end in Id/],
      ['authorId:ref(Authors)', 'authorId:ref(Authors)', /snake_case table/],
      ['onlyname', 'onlyname', /expected name:type/],
    ];
    it.each(cases)('%s', (spec, token, why) => {
      let err: unknown;
      try {
        parseFields(spec);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SpecError);
      const msg = (err as SpecError).message;
      expect(msg).toContain(`"${token}"`);
      expect(msg).toMatch(why);
      expect(msg).toContain('valid types');
      expect(msg).toContain('example');
    });
  });

  it('rejects duplicate field names and an empty --fields', () => {
    expect(() => parseFields('a:int, a:text')).toThrow(/duplicate field "a"/);
    expect(() => parseFields('')).toThrow(/missing --fields/);
    expect(() => parseFields(undefined)).toThrow(/example/);
  });

  it('unique numeric needs 2 integer digits so generated tests can seed 23 distinct rows', () => {
    expect(() => parseFields('a:numeric(3,2):unique')).toThrow(/integer digits/);
    expect(() => parseFields('a:numeric(5,2):unique')).not.toThrow();
  });

  it('validates the table name', () => {
    expect(parseTableName('book_items')).toBe('book_items');
    for (const bad of [undefined, '', 'Books', '1x', 'a-b']) expect(() => parseTableName(bad)).toThrow(/PLURAL snake_case/);
  });

  it('naming helpers', () => {
    expect(snake('priceUsdNet')).toBe('price_usd_net');
    expect(['authors', 'categories', 'boxes', 'statuses', 'address'].map(singular)).toEqual(['author', 'category', 'box', 'status', 'address']);
  });
});
