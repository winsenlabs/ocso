/** Anything registered under a name that a `*_DRIVER` setting selects. */
export interface NamedDriver {
  readonly name: string;
}

/** Driver names: what operators type into `*_DRIVER` (lower case, `a-z0-9-`). */
export const DRIVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Infrastructure drivers (email, blob, secrets, queue, deployment) are
 * registered, never switched on (build rule §4): the same register/get/has/
 * list shape as the channel, model-provider and alert registries. `setting`
 * is the environment variable that selects one, for error messages.
 */
export class DriverRegistry<D extends NamedDriver> {
  private readonly drivers = new Map<string, D>();

  constructor(
    /** e.g. `BLOB_DRIVER`. */
    readonly setting: string,
    /** e.g. `blob`, as in "registered blob drivers: local, s3". */
    readonly noun: string,
  ) {}

  register(driver: D): this {
    if (!DRIVER_NAME_PATTERN.test(driver.name)) throw new Error(`${this.noun} driver name "${driver.name}" must be lower case a-z0-9- (1-40 characters)`);
    if (this.drivers.has(driver.name)) throw new Error(`${this.noun} driver ${driver.name} is already registered`);
    this.drivers.set(driver.name, driver);
    return this;
  }

  has(name: string): boolean {
    return this.drivers.has(name);
  }

  /** The driver `name` selects; the error names the setting and every registered driver. */
  get(name: string): D {
    const driver = this.drivers.get(name);
    if (!driver) throw new Error(`Invalid OCSO configuration:\n  - ${this.unknown(name)}`);
    return driver;
  }

  list(): D[] {
    return [...this.drivers.values()];
  }

  names(): string[] {
    return [...this.drivers.keys()];
  }

  /** Problem text for a name no plugin registered. */
  unknown(name: string): string {
    return `${this.setting}=${name} is not available; registered ${this.noun} drivers: ${this.names().join(', ') || 'none'}`;
  }
}
