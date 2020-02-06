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
bazel run migration:migrate-scenes  \
	{URL OF THE V3 CONTENT SERVER} \
	{PATH TO THE FILE WITH CREDENTIALS} \
	{URL OF THE V2 CONTENT SERVER} \
	[PATH TO A DIR WHERE LOGS WILL BE SAVED] (OPTIONAL) \
	[PATH TO A DIR WITH DEFAULT SCENES] (OPTIONAL)
```

The script will read the V2 server, check if the scene has already been deployed, and deploy it on the V3 server.

## Profiles
With profiles, it gets a little bit trickier. Since there is no public API to access all profiles (and we want to keep it that way), you will have to export all profiles to a CSV.

Once you access the production database, you can run the following to generate the CSV:
```
\copy (SELECT avatar, version, name, description, eth_address FROM profiles) TO '/tmp/profiles.csv' WITH (FORMAT CSV, HEADER TRUE, FORCE_QUOTE *);
```

Then, you will need to download the CSV to somewhere you can access more easily.

Once that is done, you can run:

```
bazel run migration:migrate-profiles  \
	{URL OF THE V3 CONTENT SERVER} \
	{PATH TO THE FILE WITH CREDENTIALS} \
	{PATH TO CSV} \
	[PATH TO A DIR WHERE LOGS WILL BE SAVED] (OPTIONAL)
```
