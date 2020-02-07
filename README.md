# Content Migrator

This project ahs the ability to migrate content from V2 to V3 format.


## Set up
First, you will need to set up your credentials. Please create a text file with the following json:
```
{
    "ethAddress": "0x1337e0507EB4aB47E08a179573ED4533d9E22a7b",
    "privateKey": "..."
}
```
If you don't know the private key, please ask for it.

## Scenes
To run scene migrations, you will have to run the following:

```
bazel run migration:migrate-scenes
```

## Profiles
With profiles, it gets a little bit trickier. Since there is no public API to access all profiles (and we want to keep it that way), you will have to export all profiles to a CSV.

Once you access the production database, you can run the following to generate the CSV:
```
\copy (SELECT avatar, version, name, description, eth_address FROM profiles) TO '/tmp/profiles.csv' WITH (FORMAT CSV, HEADER TRUE, FORCE_QUOTE *);
```

Then, you will need to replace the CSV on the `resources` folder with the new one.

Once that is done, you can run:

```
bazel run migration:migrate-profiles
```
