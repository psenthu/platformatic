'use strict'

const fp = require('fastify-plugin')
const constructGraph = require('./lib/entity-to-type')
const mercurius = require('mercurius')
const graphql = require('graphql')
const establishRelations = require('./lib/relationship')
const setupSubscriptions = require('./lib/subscriptions')
const scalars = require('graphql-scalars')

async function mapperToGraphql (app, opts) {
  const mapper = app.platformatic
  const queryTopFields = {}
  const mutationTopFields = {}
  const resolvers = {}
  const loaders = {}
  const federationReplacements = []
  const relations = []

  const graphOpts = {
    queryTopFields,
    mutationTopFields,
    resolvers,
    loaders,
    federationReplacements,
    federationMetadata: opts.federationMetadata
  }
  const metaMap = new Map()

  if (Object.keys(mapper.entities).length === 0) {
    // no schema
    queryTopFields.hello = { type: graphql.GraphQLString }
    resolvers.Query = {
      hello: () => 'Hello Platformatic!'
    }
  } else {
    for (const entity of Object.values(mapper.entities)) {
      relations.push(...entity.relations)
      const meta = constructGraph(app, entity, graphOpts)
      metaMap.set(entity, meta)
    }

    establishRelations(app, relations, resolvers, loaders, queryTopFields, opts.resolvers || {}, metaMap)

    if (opts.resolvers) {
      for (const key of Object.keys(opts.resolvers)) {
        if (!resolvers[key]) {
          resolvers[key] = {}
        }

        const type = opts.resolvers[key]
        for (const resolver of Object.keys(type)) {
          if (type[resolver] === false) {
            if (resolvers[key][resolver]) {
              delete resolvers[key][resolver]
            }
            if (loaders[key]) {
              delete loaders[key][resolver]
            }
            /* istanbul ignore else */
            if (key === 'Mutation') {
              delete mutationTopFields[resolver]
            } else if (key === 'Query') {
              delete queryTopFields[resolver]
            }
          } else {
            resolvers[key][resolver] = type[resolver]
          }
        }
      }
    }
  }

  const query = new graphql.GraphQLObjectType({
    name: 'Query',
    fields: queryTopFields
  })

  const mutation = Object.keys(mutationTopFields).length > 0
    ? new graphql.GraphQLObjectType({
      name: 'Mutation',
      fields: mutationTopFields
    })
    : null

  if (!mutation) {
    delete resolvers.Mutation
  }

  let subscription
  if (app.platformatic.mq) {
    const entitiesList = Object.keys(app.platformatic.entities)
    const ignoreList = opts.subscriptionIgnore || []

    if (entitiesList.length - ignoreList.length > 0) {
      opts.subscription = {
        emitter: app.platformatic.mq
      }
      // TODO support ignoring some of those
      subscription = setupSubscriptions(app, metaMap, resolvers, ignoreList)
    }
  }

  let sdl = graphql.printSchema(new graphql.GraphQLSchema({ query, mutation, subscription }))

  if (opts.federationMetadata) {
    for (const replacement of federationReplacements) {
      sdl = sdl.replace(replacement.find, replacement.replace)
    }
    sdl = sdl.replace('type Query', 'type Query @extends')
  }

  if (opts.schema) {
    sdl += '\n'
    sdl += opts.schema
  }
  // Ignoriring because SQLite doesn't support dates
  /* istanbul ignore next */
  if (sdl.match(/scalar Date\n/)) {
    resolvers.Date = scalars.GraphQLDate
  }
  if (sdl.indexOf('scalar DateTime') >= 0) {
    resolvers.DateTime = scalars.GraphQLDateTime
  }

  opts.graphiql = opts.graphiql !== false

  await app.register(mercurius, {
    ...opts,
    schema: sdl,
    loaders,
    resolvers
  })

  app.log.debug({ schema: sdl }, 'computed schema')
}

module.exports = fp(mapperToGraphql)
