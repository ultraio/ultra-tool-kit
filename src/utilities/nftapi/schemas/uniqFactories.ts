export const schema = `query UniqFactories(
  $assetManager: WalletId,
  $pagination: PaginationInput
) {
  uniqFactories(
    assetManager: $assetManager,
    pagination: $pagination
  ) {
    data {
      accountMintingLimit
      assetCreator
      assetManager
      authorizedMinters {
        quantity
        walletId
      }
      conditionlessReceivers
      defaultUniqMetadata {
        cachedSource {
          contentType
          integrity {
            hash
            type
          }
          uri
        }
        content {
          attributes {
            descriptor {
              description
              dynamic
              name
              type
            }
            key
            value
          }
          description
          dynamicAttributes {
            contentType
            uris
          }
          dynamicResources {
            key
            value {
              contentType
              uris
            }
          }
          medias {
            gallery {
              contentType
              integrity {
                hash
                type
              }
              uri
            }
            hero {
              contentType
              integrity {
                hash
                type
              }
              uri
            }
            product {
              contentType
              integrity {
                hash
                type
              }
              uri
            }
            square {
              contentType
              integrity {
                hash
                type
              }
              uri
            }
          }
          name
          properties
          resources {
            key
            value {
              contentType
              integrity {
                hash
                type
              }
              uri
            }
          }
          subName
        }
        source {
          contentType
          integrity {
            hash
            type
          }
          uri
        }
        status
      }
      firsthandPurchases {
        groupRestriction {
          excludes
          includes
        }
        id
        option {
          factories {
            count
            id
            strategy
          }
          transferUniqsReceiver
        }
        price {
          amount
          currency {
            code
            symbol
          }
        }
        promoterBasisPoints
        purchaseLimit
        purchaseWindow {
          endDate
          startDate
        }
        purchasedUniqs
        saleShares {
          basisPoints
          receiver
        }
        uosPayment
      }
      id
      metadata {
        cachedSource {
          contentType
          integrity {
            hash
            type
          }
          uri
        }
        content {
          attributes {
            key
            value {
              description
              dynamic
              name
              type
            }
          }
          description
          medias {
            gallery {
              contentType
              integrity {
                hash
                type
              }
              uri
            }
            hero {
              contentType
              integrity {
                hash
                type
              }
              uri
            }
            product {
              contentType
              integrity {
                hash
                type
              }
              uri
            }
            square {
              contentType
              integrity {
                hash
                type
              }
              uri
            }
          }
          name
          properties
          resources {
            key
            value {
              contentType
              integrity {
                hash
                type
              }
              uri
            }
          }
          subName
        }
        locked
        source {
          contentType
          integrity {
            hash
            type
          }
          uri
        }
        status
      }
      mintableWindow {
        endDate
        startDate
      }
      resale {
        minimumPrice {
          amount
          currency {
            code
            symbol
          }
        }
        shares {
          basisPoints
          receiver
        }
      }
      status
      stock {
        authorized
        existing
        maxMintable
        mintable
        minted
      }
      tradingWindow {
        endDate
        startDate
      }
      transferWindow {
        endDate
        startDate
      }
      type
    }
    pagination {
      limit
      skip
    }
    totalCount
  }
}`;
