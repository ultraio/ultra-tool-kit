export const receivedOffersSchema = `
query UniqEffectiveBuyOffers(
  $pagination: PaginationInput
  $subject: UniqBuyOfferSubjectInput!
  $type: UniqBuyOfferType
) {
  uniqEffectiveBuyOffers(
    pagination: $pagination
    subject: $subject
    type: $type
  ) {
    data {
      id
      type
      expiryDate
      buyer
      uniq {
        id
        owner
      }
      uniqFactory {
        id
        assetManager
      }
      price {
        amount
        currency {
          code
          symbol
        }
      }
      receiver
    }
    pagination {
      limit
      skip
    }
    totalCount
  }
}
`;

export const sentOffersSchema = `
query UniqBuyOffers($buyer: WalletId, $uniqFactoryId: BigInt, $pagination: PaginationInput) {
  uniqBuyOffers(buyer: $buyer, uniqFactoryId: $uniqFactoryId, pagination: $pagination) {
    data {
      id
      type
      expiryDate
      uniqId
      uniqFactoryId
      buyer
      uniq {
        owner
      }
      uniqFactory {
        owner: assetCreator
      }
      price {
        amount
        currency {
          code
          symbol
        }
      }
    }
    pagination {
      limit
      skip
    }
    totalCount
  }
}

`;
