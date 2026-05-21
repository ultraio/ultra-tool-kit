#include <eosio/eosio.hpp>

namespace fixture {

void delegated::setconrecv(const name& payer, const name& receiver)
{
    setconrecv_v1(payer, receiver);
}

void delegated::setconrecv_v1(const name& payer, const name& receiver)
{
    require_auth(payer);
    check(is_account(receiver), "receiver account does not exist");
}

}
